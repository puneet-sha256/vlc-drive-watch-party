import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import { GoogleDrive, type Drive } from "./drive.js";
import { Vlc, type PlayerState } from "./vlc.js";
import { matches, secret, startSyncServer } from "./sync-server.js";
import { driftTolerance, parseInvite, protocolVersion, serverOrigin, syncInterval, type Media, type Snapshot } from "./protocol.js";
import type { ManagedTunnel } from "./tunnel.js";

export interface CompanionOptions {
  port: number; vlc: Vlc; drive: Drive; google?: GoogleDrive;
  syncPort?: number; publicSyncUrl?: string; apiKey?: string; appId?: string;
  tunnel?: ManagedTunnel; onQuit?: () => void;
}
export async function startCompanion(options: CompanionOptions) {
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const localKey = secret();
  const clientId = randomUUID();
  let origin = "";
  let selected: Media | undefined;
  let mediaKey = secret();
  let socket: Socket | undefined;
  let room: Snapshot | undefined;
  let isHost = false;
  let invite = "";
  let error = "";
  let vlcStarted = false;
  let videoBytes = 0;
  let appliedRevision = -1;
  let appliedSeekRevision = -1;
  let alignOnConnect = true;
  let waiting = false;
  let pendingSeek: { position: number; started: number } | undefined;
  let commandedPlaying: boolean | undefined;
  let playbackStatus = "Not in a party.";
  const playbackEvents: Array<{ at: number; message: string }> = [];
  const reportStatus = (message: string) => {
    if (message === playbackStatus) return;
    playbackStatus = message;
    playbackEvents.push({ at: Date.now(), message });
    if (playbackEvents.length > 20) playbackEvents.shift();
  };
  let previous: (PlayerState & { at: number }) | undefined;
  let hostServer: Awaited<ReturnType<typeof startSyncServer>> | undefined;
  const streams = new Set<AbortController>();
  let tail = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.then(() => {}, () => {});
    return next;
  };
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.host !== new URL(origin).host) return reply.code(403).send({ error: "Invalid local host" });
    if (req.url.startsWith("/api/")) {
      if (!matches(req.headers.authorization, `Bearer ${localKey}`)) return reply.code(403).send({ error: "Open the companion's launch window" });
      if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({ error: "Invalid browser origin" });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.setErrorHandler((caught, _req, reply) => {
    error = caught instanceof Error ? caught.message : "The operation failed";
    reply.code(400).send({ error });
  });
  const stopParty = async () => {
    if (isHost) options.tunnel?.stop();
    socket?.disconnect(); socket = undefined; room = undefined; invite = ""; previous = undefined;
    waiting = false; pendingSeek = undefined; commandedPlaying = undefined;
    appliedRevision = -1; appliedSeekRevision = -1; alignOnConnect = true;
    reportStatus("Not in a party.");
    isHost = false;
    for (const stream of streams) stream.abort();
    mediaKey = secret();
    if (vlcStarted) await options.vlc.pause().catch(() => {});
  };
  const send = async (action: "play" | "pause" | "seek", position: number) => {
    if (!socket?.connected || !room || !isHost) throw new Error("Only the connected host can control the party.");
    const result = await socket.timeout(5000).emitWithAck("command", { action, position, revision: room.playback.revision });
    if (result.snapshot) acceptSnapshot(result.snapshot);
    if (result.error) throw new Error(result.error);
  };
  function acceptSnapshot(next: Snapshot) {
    if (next.protocolVersion !== protocolVersion) {
      error = "Update Watch Party on every computer before joining.";
      return;
    }
    if (room && next.playback.revision < room.playback.revision) return;
    room = next;
    if (alignOnConnect || appliedRevision !== next.playback.revision || waiting !== next.waiting.includes(clientId)) {
      void serial(() => applyPlayback()).catch(() => { error = "Could not synchronize VLC. Check that VLC and the host are running."; });
    }
  }
  const connect = async (remote: string, roomId: string, ticket: string, host: boolean) => {
    isHost = host;
    mediaKey = secret();
    await options.vlc.open(`${origin}/media/${mediaKey}`);
    vlcStarted = true;
    socket = io(remote, {
      auth: { roomId, ticket, clientId, protocolVersion }, transports: ["websocket"], timeout: 10000,
      extraHeaders: { "X-Tunnel-Skip-AntiPhishing-Page": "true" }
    });
    const current = socket;
    socket.on("snapshot", (next: Snapshot) => { if (socket === current) acceptSnapshot(next); });
    socket.on("connect", () => {
      error = ""; previous = undefined; alignOnConnect = true;
      appliedRevision = -1; appliedSeekRevision = -1; pendingSeek = undefined;
      reportStatus("Connected. Aligning playback.");
    });
    socket.on("disconnect", () => {
      if (socket !== current) return;
      error = "Sync disconnected. Playback paused while reconnecting.";
      reportStatus(error);
      void options.vlc.pause().catch(() => {});
    });
    socket.on("connect_error", () => { error = "Cannot connect to this party. Check the invite, tunnel access and host."; });
    socket.on("closed", (reason: string) => {
      error = reason; socket?.disconnect(); void options.vlc.pause().catch(() => {});
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { current.disconnect(); reject(new Error("Party connection timed out. Check the invite and tunnel access.")); }, 12000);
      current.once("snapshot", () => { clearTimeout(timer); resolve(); });
      current.once("connect_error", () => { clearTimeout(timer); current.disconnect(); reject(new Error("Party connection was rejected. Check tunnel access and the invite.")); });
    });
  };
  app.get("/", async (_req, reply) => reply.type("text/html").send(await readFile(new URL("../web/index.html", import.meta.url), "utf8")));
  app.get("/api/state", async () => ({
    signedIn: options.google?.signedIn ?? true, selected, room, isHost,
    connected: Boolean(socket?.connected), invite,
    error: error || (isHost && options.tunnel?.status.state === "error" ? options.tunnel.status.message : ""), videoBytes,
    playbackStatus, waiting, playbackEvents,
    player: previous && { playing: previous.playing, position: previous.position, duration: previous.duration },
    configured: Boolean(options.google?.configured && options.apiKey && options.appId),
    publicSyncUrl: options.tunnel?.status.origin || options.publicSyncUrl || "",
    tunnel: options.tunnel?.status, canQuit: Boolean(options.onQuit), vlcAvailable: await options.vlc.available()
  }));
  app.post("/api/tunnel/login", async req => {
    if (!options.tunnel) throw new Error("Managed hosting is available in the installed desktop application.");
    const { provider } = z.object({ provider: z.enum(["microsoft", "github"]) }).parse(req.body);
    options.tunnel.login(provider);
    error = "";
    return { ok: true };
  });
  app.post("/api/tunnel/cancel", async () => {
    if (!options.tunnel) throw new Error("Managed hosting is not enabled.");
    options.tunnel.cancelLogin();
    error = "";
    return { ok: true };
  });
  app.post("/api/quit", async (_req, reply) => {
    if (!options.onQuit) throw new Error("Close the terminal to stop this development instance.");
    reply.send({ ok: true });
    setTimeout(() => options.onQuit?.(), 100).unref();
  });
  app.post("/api/login", async () => {
    if (!options.google) throw new Error("Google sign-in is not configured");
    return { url: options.google.login() };
  });
  app.get("/oauth/callback", async (req, reply) => {
    const query = z.object({ state: z.string(), code: z.string() }).parse(req.query);
    if (!options.google) throw new Error("Google sign-in is not configured");
    await options.google.callback(query.state, query.code);
    return reply.redirect(`${origin}/#key=${localKey}`);
  });
  app.get("/api/picker", async () => {
    if (!options.google || !options.apiKey || !options.appId) throw new Error("Configure GOOGLE_API_KEY and GOOGLE_APP_ID in .env.");
    return { token: await options.google.token(), apiKey: options.apiKey, appId: options.appId };
  });
  app.post("/api/select", async req => serial(async () => {
    const { fileId } = z.object({ fileId: z.string().min(1).max(256) }).parse(req.body);
    await stopParty();
    selected = await options.drive.metadata(fileId);
    error = "";
    return selected;
  }));
  app.post("/api/host", async () => serial(async () => {
    if (!selected) throw new Error("Choose a Drive video first.");
    await stopParty();
    selected = await options.drive.metadata(selected.fileId);
    hostServer ??= await startSyncServer(options.syncPort ?? 43822);
    const publicOrigin = options.tunnel
      ? await options.tunnel.start(Number(new URL(hostServer.origin).port))
      : options.publicSyncUrl ? serverOrigin(options.publicSyncUrl) : hostServer.origin;
    const response = await fetch(`${hostServer.origin}/rooms`, {
      method: "POST", headers: { Authorization: `Bearer ${hostServer.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(selected)
    });
    if (!response.ok) throw new Error("Could not create the room.");
    const created = await response.json() as { roomId: string; hostKey: string; guestKey: string };
    await connect(hostServer.origin, created.roomId, created.hostKey, true);
    invite = `${publicOrigin}/#room=${created.roomId}&key=${created.guestKey}`;
    return { invite };
  }));
  app.post("/api/join", async req => serial(async () => {
    const parsed = parseInvite(z.object({ invite: z.string().max(2048) }).parse(req.body).invite);
    const response = await fetch(`${parsed.origin}/rooms/${parsed.roomId}`, {
      headers: { Authorization: `Bearer ${parsed.ticket}`, "X-Tunnel-Skip-AntiPhishing-Page": "true" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("The invite is unavailable. Check the host and Dev Tunnel access.");
    const target = await response.json() as Snapshot;
    if (target.protocolVersion !== protocolVersion) throw new Error("Update Watch Party on every computer before joining.");
    if (!target.media?.fileId) throw new Error("This server did not return a valid room.");
    const media = await options.drive.metadata(target.media.fileId).catch(() => {
      throw new Error(`Choose the original "${target.media.name}" in Google Picker, then retry Join. The owner must share it with your account.`);
    });
    await stopParty();
    selected = media;
    await connect(parsed.origin, parsed.roomId, parsed.ticket, false);
    invite = `${parsed.origin}/#room=${parsed.roomId}&key=${parsed.ticket}`;
    return { joined: true };
  }));
  app.post("/api/command", async req => serial(async () => {
    const command = z.object({ action: z.enum(["play", "pause", "seek"]), position: z.number().finite().min(0).max(86400).optional() }).parse(req.body);
    const status = await options.vlc.status();
    await send(command.action, command.position ?? status.position);
    await applyPlayback();
    return { ok: true };
  }));
  app.post("/api/leave", async () => serial(async () => { await stopParty(); return { ok: true }; }));
  app.route<{ Params: { key: string } }>({
    method: ["GET", "HEAD"], url: "/media/:key", handler: async (req, reply) => {
      if (!selected || !matches(req.params.key, mediaKey)) return reply.code(403).send();
      if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) return reply.code(416).send();
      const abort = new AbortController();
      streams.add(abort);
      reply.raw.once("close", () => { abort.abort(); streams.delete(abort); });
      const upstream = await options.drive.open(selected.fileId, req.headers.range, abort.signal);
      if (!upstream.ok) { await upstream.body?.cancel(); return reply.code(upstream.status).send(); }
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.code(upstream.status);
      if (req.method === "HEAD" || !upstream.body) { await upstream.body?.cancel(); return reply.send(); }
      const reader = upstream.body.getReader();
      return reply.send(Readable.from((async function* () {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            videoBytes += value.length;
            yield value;
          }
        } finally { reader.releaseLock(); }
      })()));
    }
  });
  async function applyPlayback(observed?: PlayerState): Promise<PlayerState | undefined> {
    if (!room || !vlcStarted || !socket?.connected) return;
    const next = room;
    let current = observed ?? await options.vlc.status();
    if (!["playing", "paused"].includes(current.raw.state) || !current.duration) return current;
    const transportChanged = appliedRevision !== next.playback.revision;
    const mustSeek = alignOnConnect || appliedSeekRevision !== next.playback.seekRevision;
    const hold = next.waiting.includes(clientId);
    let controlled = false;
    if (mustSeek) {
      const position = Math.max(0, Math.min(current.duration - 0.05,
        alignOnConnect ? next.joinPosition : next.playback.seekPosition));
      if (Math.abs(position - current.position) > (alignOnConnect ? 1 : 0.15)) {
        await options.vlc.seek(position, current.duration);
        pendingSeek = { position, started: Date.now() };
        reportStatus(`Seeking to ${position.toFixed(1)} seconds.`);
        controlled = true;
      }
      alignOnConnect = false;
      appliedSeekRevision = next.playback.seekRevision;
    }
    const play = next.playback.playing && !hold;
    if (transportChanged || hold !== waiting || current.playing !== play) {
      commandedPlaying = play;
      await (play ? options.vlc.play() : options.vlc.pause());
      controlled = true;
    }
    waiting = hold;
    appliedRevision = next.playback.revision;
    if (controlled) {
      current = await options.vlc.status();
      previous = { ...current, at: Date.now() };
    }
    return current;
  }
  let ticking = false;
  const tick = async () => {
    if (!room || !vlcStarted) return;
    if (!socket?.connected) { await options.vlc.pause(); return; }
    let current = await options.vlc.status();
    if (!socket.connected) { await options.vlc.pause(); return; }
    const now = Date.now();
    const ready = ["playing", "paused"].includes(current.raw.state) && current.duration > 0;
    if (commandedPlaying === current.playing) commandedPlaying = undefined;
    if (isHost && ready && previous && !pendingSeek && appliedRevision === room.playback.revision) {
      // Falling short of expected progress may be buffering, not a native backward seek.
      const movement = current.position - previous.position;
      const anticipated = previous.playing ? (now - previous.at) / 1000 : 0;
      if (movement < -0.5 || movement > anticipated + 1.5) await send("seek", current.position);
      else if (current.playing !== previous.playing && commandedPlaying === undefined) {
        await send(current.playing ? "play" : "pause", current.position);
      }
    }
    current = await applyPlayback(current) ?? current;
    if (!ready) {
      reportStatus("VLC is loading or buffering.");
      if (!pendingSeek && !alignOnConnect && Number.isFinite(current.position) && current.duration > 0) {
        socket.emit("progress", { position: current.position, revision: appliedRevision });
      }
      previous = { ...current, at: Date.now() };
      return;
    }
    if (pendingSeek) {
      const elapsed = room.playback.playing ? (Date.now() - pendingSeek.started) / 1000 : 0;
      if (current.position < pendingSeek.position - driftTolerance || current.position > pendingSeek.position + driftTolerance + elapsed) {
        reportStatus("Waiting for VLC to finish the host seek.");
        previous = { ...current, at: Date.now() };
        return;
      }
      pendingSeek = undefined;
    }
    const stalled = room.playback.playing && !waiting && previous?.playing &&
      now - previous.at >= 750 && Math.abs(current.position - previous.position) < 0.05;
    reportStatus(waiting ? "Waiting for another viewer to catch up."
      : !room.playback.playing ? "Paused by the host."
      : stalled ? "Local playback is buffering or stalled."
      : room.recovering ? "Playing. A slow viewer is recovering without holding the party."
      : "Playing within the 3-second tolerance.");
    socket.emit("progress", { position: current.position, revision: appliedRevision });
    previous = { ...current, at: Date.now() };
  };
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void serial(tick).catch(() => { error = "Could not synchronize VLC. Check that VLC and the host are running."; })
      .finally(() => { ticking = false; });
  }, syncInterval);
  await app.listen({ host: "127.0.0.1", port: options.port });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Local listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    app, origin, localKey, launchUrl: `${origin}/#key=${localKey}`,
    async close() {
      clearInterval(timer);
      await serial(stopParty);
      options.vlc.dispose();
      options.tunnel?.close();
      await hostServer?.close();
      await app.close();
    }
  };
}
