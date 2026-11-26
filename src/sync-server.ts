import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { Server } from "socket.io";
import { z } from "zod";
import {
  commandSchema, driftTolerance, expected, maximumWait, mediaSchema, progressLifetime,
  progressSchema, protocolVersion, resumeTolerance, syncInterval, type Snapshot
} from "./protocol.js";

export const secret = () => randomBytes(32).toString("hex");
export function matches(a: unknown, b: string): boolean {
  return typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export interface Participant {
  clientId: string; host: boolean;
  progress?: { position: number; revision: number; receivedAt: number };
  heldSince?: number; recovering?: boolean;
}
export function updateWaiting(participants: Participant[], revision: number, playing: boolean, now = Date.now()) {
  const active = participants.filter(p => {
    const fresh = playing && p.progress?.revision === revision && now - p.progress.receivedAt <= progressLifetime;
    if (!fresh) p.heldSince = undefined;
    return fresh;
  });
  const furthest = Math.max(...active.map(p => p.progress!.position));
  for (const p of active) {
    if (furthest - p.progress!.position <= resumeTolerance) p.recovering = false;
  }
  let eligible = active.filter(p => !p.recovering);
  let minimum = Math.min(...eligible.map(p => p.progress!.position));
  for (const p of active) {
    const drift = p.progress!.position - minimum;
    const hold = !p.recovering && drift > (p.heldSince === undefined ? driftTolerance : resumeTolerance);
    p.heldSince = hold ? p.heldSince ?? now : undefined;
  }
  if (active.some(p => p.heldSince !== undefined && now - p.heldSince >= maximumWait)) {
    // A stalled viewer may recover naturally, but cannot hold everyone indefinitely.
    for (const p of eligible) {
      if (furthest - p.progress!.position > resumeTolerance) p.recovering = true;
      p.heldSince = undefined;
    }
    eligible = active.filter(p => !p.recovering);
    minimum = Math.min(...eligible.map(p => p.progress!.position));
    for (const p of eligible) {
      if (p.progress!.position - minimum > driftTolerance) p.heldSince = now;
    }
  }
  return {
    waiting: [...new Set(active.filter(p => p.heldSince !== undefined).map(p => p.clientId))],
    recovering: active.filter(p => p.recovering).length
  };
}
interface Room {
  snapshot: Snapshot; hostKey: string; guestKey: string;
  sockets: Map<string, Participant>;
  closeTimer?: NodeJS.Timeout;
}

export async function startSyncServer(port = 43822) {
  const adminKey = secret();
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const rooms = new Map<string, Room>();
  const io = new Server(app.server, { maxHttpBufferSize: 8192, serveClient: false });
  const snapshot = (room: Room) => {
    const participants = [...room.sockets.values()];
    const host = participants.find(p => p.host && p.progress?.revision === room.snapshot.playback.revision);
    return {
      ...room.snapshot, participants: new Set(participants.map(p => p.clientId)).size,
      joinPosition: host?.progress?.position ?? expected(room.snapshot.playback),
      ...updateWaiting(participants, room.snapshot.playback.revision, room.snapshot.playback.playing)
    };
  };
  const broadcast = (room: Room) => io.to(room.snapshot.roomId).emit("snapshot", snapshot(room));
  const resetProgress = (room: Room) => {
    for (const p of room.sockets.values()) {
      p.progress = undefined; p.heldSince = undefined; p.recovering = false;
    }
  };
  const timer = setInterval(() => { for (const room of rooms.values()) broadcast(room); }, syncInterval);
  timer.unref();
  app.get("/health", async () => ({ ready: true, role: "sync-only", rooms: rooms.size }));
  app.get("/", async (_req, reply) => reply.type("text/plain").send(
    "VLC Drive Watch Party synchronization server.\nCopy the complete invite URL into the companion running on your own computer.\nNo media is served here."
  ));
  app.post("/rooms", async (req, reply) => {
    if (!matches(req.headers.authorization, `Bearer ${adminKey}`)) return reply.code(403).send({ error: "Host authorization required" });
    if (rooms.size >= 20) return reply.code(429).send({ error: "Room limit reached" });
    const media = mediaSchema.parse(req.body);
    const roomId = randomUUID();
    const room: Room = {
      snapshot: {
        roomId, media, participants: 0, protocolVersion, joinPosition: 0, waiting: [], recovering: 0,
        playback: { playing: false, position: 0, timestamp: Date.now(), revision: 0, seekRevision: 0, seekPosition: 0 }
      },
      hostKey: secret(), guestKey: secret(), sockets: new Map()
    };
    rooms.set(roomId, room);
    room.closeTimer = setTimeout(() => { if (!room.sockets.size) rooms.delete(roomId); }, 60000).unref();
    return { roomId, hostKey: room.hostKey, guestKey: room.guestKey };
  });
  app.get<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
    const room = rooms.get(req.params.id);
    if (!room || !matches(req.headers.authorization, `Bearer ${room.guestKey}`)) {
      return reply.code(403).send({ error: "Invalid room invite" });
    }
    return snapshot(room);
  });
  io.use((socket, next) => {
    if (socket.handshake.auth.protocolVersion !== protocolVersion) return next(new Error("Update Watch Party on every computer before joining."));
    const parsed = z.object({ roomId: z.string().uuid(), clientId: z.string().uuid(), ticket: z.string().max(128) }).safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error("Invalid room credentials"));
    const room = rooms.get(parsed.data.roomId);
    const host = room && matches(parsed.data.ticket, room.hostKey);
    if (!room || (!host && !matches(parsed.data.ticket, room.guestKey))) return next(new Error("Invalid room invite"));
    if (!host && room.sockets.size >= 5) return next(new Error("Room is full"));
    socket.data.room = room;
    socket.data.clientId = parsed.data.clientId;
    socket.data.host = host;
    next();
  });
  io.on("connection", socket => {
    const room = socket.data.room as Room;
    if (socket.data.host) { clearTimeout(room.closeTimer); room.closeTimer = undefined; }
    room.sockets.set(socket.id, { clientId: socket.data.clientId, host: socket.data.host });
    socket.join(room.snapshot.roomId);
    broadcast(room);
    socket.on("ping-clock", (ack: unknown) => { if (typeof ack === "function") ack(Date.now()); });
    socket.on("progress", (raw: unknown) => {
      const progress = progressSchema.safeParse(raw);
      const participant = room.sockets.get(socket.id);
      if (!participant || !progress.success || progress.data.revision !== room.snapshot.playback.revision) return;
      if (participant.progress && Date.now() - participant.progress.receivedAt < 200) return;
      participant.progress = { ...progress.data, receivedAt: Date.now() };
      broadcast(room);
    });
    let lastCommand = 0;
    socket.on("command", (raw: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const command = commandSchema.safeParse(raw);
      if (!socket.data.host || !command.success) return ack({ error: "Only the host may send valid playback commands" });
      if (Date.now() - lastCommand < 80) return ack({ error: "Too many commands" });
      const current = room.snapshot.playback;
      if (command.data.revision !== current.revision) return ack({ error: "Playback changed; retry", snapshot: snapshot(room) });
      lastCommand = Date.now();
      room.snapshot.playback = {
        ...current,
        playing: command.data.action === "seek" ? current.playing : command.data.action === "play",
        position: command.data.position, timestamp: Date.now(), revision: current.revision + 1,
        ...(command.data.action === "seek" ? { seekPosition: command.data.position, seekRevision: current.revision + 1 } : {})
      };
      resetProgress(room);
      broadcast(room);
      ack({ snapshot: snapshot(room) });
    });
    socket.on("disconnect", () => {
      const position = snapshot(room).joinPosition;
      room.sockets.delete(socket.id);
      if (socket.data.host && ![...room.sockets.values()].some(s => s.host)) {
        room.snapshot.playback = {
          ...room.snapshot.playback, playing: false, position,
          timestamp: Date.now(), revision: room.snapshot.playback.revision + 1
        };
        resetProgress(room);
        room.closeTimer = setTimeout(() => {
          io.to(room.snapshot.roomId).emit("closed", "Host did not reconnect");
          io.in(room.snapshot.roomId).disconnectSockets(true);
          rooms.delete(room.snapshot.roomId);
        }, 60000).unref();
      }
      broadcast(room);
    });
  });
  app.setErrorHandler((_error, _req, reply) => reply.code(400).send({ error: "Invalid request" }));
  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Sync listener unavailable");
  return {
    app, adminKey, origin: `http://127.0.0.1:${address.port}`,
    async close() {
      clearInterval(timer);
      await io.close();
      for (const room of rooms.values()) clearTimeout(room.closeTimer);
      rooms.clear();
      await app.close();
    }
  };
}
