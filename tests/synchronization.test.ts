import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { io, type Socket } from "socket.io-client";
import { startCompanion } from "../src/companion.js";
import { maximumWait, progressLifetime, protocolVersion, type Snapshot } from "../src/protocol.js";
import { startSyncServer, updateWaiting, type Participant } from "../src/sync-server.js";
import { Vlc, type PlayerState } from "../src/vlc.js";
import type { Drive } from "../src/drive.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}
function participant(position: number, now = 1000): Participant {
  return { clientId: randomUUID(), host: false, progress: { position, revision: 1, receivedAt: now } };
}

test("waiting tolerates three seconds, resumes within one, and drops stale or old-revision reports", () => {
  const slow = participant(10), fast = participant(13);
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1000).waiting, []);
  fast.progress!.position = 13.1;
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1000).waiting, [fast.clientId]);
  slow.progress!.position = 11.5;
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1100).waiting, [fast.clientId]);
  slow.progress!.position = 12.2;
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1200).waiting, []);
  slow.progress!.position = 0;
  assert.equal(updateWaiting([slow, fast], 1, true, 1300).waiting.length, 1);
  assert.deepEqual(updateWaiting([slow, fast], 2, true, 1400).waiting, []);
  updateWaiting([slow, fast], 1, true, 1500);
  fast.progress!.receivedAt = 1000 + progressLifetime + 1;
  assert.deepEqual(updateWaiting([slow, fast], 1, true, fast.progress!.receivedAt).waiting, []);
  slow.progress!.receivedAt = fast.progress!.receivedAt;
  updateWaiting([slow, fast], 1, true, fast.progress!.receivedAt);
  assert.deepEqual(updateWaiting([slow, fast], 1, false, fast.progress!.receivedAt).waiting, []);
});

test("a persistently stalled viewer stops holding the party and rejoins coordination only after catching up", () => {
  const slow = participant(0), fast = participant(5);
  updateWaiting([slow, fast], 1, true, 1000);
  slow.progress!.receivedAt = fast.progress!.receivedAt = 1000 + maximumWait;
  const timedOut = updateWaiting([slow, fast], 1, true, 1000 + maximumWait);
  assert.deepEqual(timedOut.waiting, []);
  assert.equal(timedOut.recovering, 1);
  assert.equal(slow.recovering, true);
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1001 + maximumWait).waiting, []);
  slow.progress!.position = 4.5;
  assert.equal(updateWaiting([slow, fast], 1, true, 1002 + maximumWait).recovering, 0);
  slow.progress!.position = 0;
  assert.deepEqual(updateWaiting([slow, fast], 1, true, 1003 + maximumWait).waiting, [fast.clientId]);
});

class SimulatedVlc extends Vlc {
  position = 0;
  playing = false;
  seeks: number[] = [];
  advanced = 0;
  statusDelay = 0;
  private last = performance.now();
  private readyAt = 0;
  constructor(private seekRecovery = 0) { super("synthetic-only"); }
  private advance() {
    const now = performance.now();
    if (this.playing) {
      const elapsed = Math.max(0, now - Math.max(this.last, this.readyAt)) / 1000;
      this.position += elapsed; this.advanced += elapsed;
    }
    this.last = now;
  }
  stall(ms: number) { this.advance(); this.readyAt = performance.now() + ms; }
  nativeSeek(position: number) { this.advance(); this.position = position; }
  override async available() { return true; }
  override async open() { await this.pause(); }
  override async status(): Promise<PlayerState> {
    const delay = this.statusDelay;
    this.statusDelay = 0;
    if (delay) await sleep(delay);
    this.advance();
    return { position: this.position, playing: this.playing, duration: 180, raw: { state: this.playing ? "playing" : "paused", rate: 1 } };
  }
  override async play() { this.advance(); this.playing = true; }
  override async pause() { this.advance(); this.playing = false; }
  override async seek(position: number) {
    this.advance(); this.position = position; this.seeks.push(position);
    this.readyAt = performance.now() + this.seekRecovery;
  }
  override async request() { throw new Error("Routine synchronization must not change playback rate."); }
  override dispose() {}
}
const media = { fileId: "synthetic", name: "synthetic.mkv", mimeType: "video/x-matroska", size: 100 };
const drive: Drive = {
  async metadata() { return media; },
  async open() { throw new Error("Simulated players must not download media."); }
};
type Companion = Awaited<ReturnType<typeof startCompanion>>;
async function api(client: Companion, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${client.origin}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${client.localKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.equal(response.status, 200, `API ${path} failed`);
  return response.json();
}
async function party() {
  const hostVlc = new SimulatedVlc(), guestVlc = new SimulatedVlc(1200);
  const host = await startCompanion({ port: 0, syncPort: 0, drive, vlc: hostVlc });
  let guest: Companion | undefined;
  try {
    guest = await startCompanion({ port: 0, drive, vlc: guestVlc });
    await api(host, "select", { fileId: media.fileId });
    const { invite } = await api(host, "host", {});
    await api(guest, "join", { invite });
    await api(host, "command", { action: "play" });
    await until(() => hostVlc.playing && guestVlc.playing, "initial playback");
    return { host, guest, hostVlc, guestVlc, async close() { await guest!.close(); await host.close(); } };
  } catch (error) { await guest?.close(); await host.close(); throw error; }
}

test("a buffering guest catches up while only the ahead host waits, without corrective seeks or global pause", { timeout: 25000 }, async () => {
  const p = await party();
  try {
    await sleep(1200);
    const seeks = p.guestVlc.seeks.length;
    const revision = (await api(p.host, "state")).room.playback.revision;
    p.guestVlc.stall(5200);
    await until(async () => (await api(p.host, "state")).waiting, "host waits for buffering guest");
    assert.equal(p.hostVlc.playing, false);
    assert.equal(p.guestVlc.playing, true);
    assert.equal((await api(p.guest, "state")).room.playback.playing, true);
    const held = await api(p.host, "state");
    assert.ok(Math.abs(held.room.joinPosition - p.hostVlc.position) < 1, "late joins use actual held host position");
    await until(async () => !(await api(p.host, "state")).waiting && p.hostVlc.playing, "host resumes after guest catches up");
    assert.equal(p.guestVlc.seeks.length, seeks);
    assert.equal(p.hostVlc.seeks.length, 0);
    assert.equal((await api(p.host, "state")).room.playback.revision, revision, "automatic waiting is not a host transport command");
    assert.ok((await api(p.host, "state")).playbackEvents.some((event: any) => event.message.startsWith("Waiting for another")));
  } finally { await p.close(); }
});

test("host seeks bypass waiting immediately in both directions and preserve paused playback", { timeout: 25000 }, async () => {
  const p = await party();
  try {
    p.guestVlc.stall(20000);
    await until(async () => (await api(p.host, "state")).waiting, "host waiting before seek");
    const started = performance.now();
    await api(p.host, "command", { action: "seek", position: 70 });
    await until(() => p.guestVlc.seeks.includes(70), "immediate guest seek", 750);
    assert.ok(performance.now() - started < 900, "seek must not wait for the one-second telemetry tick");
    assert.equal(p.hostVlc.playing, true);
    assert.equal(p.guestVlc.playing, true);
    assert.equal((await api(p.host, "state")).waiting, false);
    await sleep(150);
    await api(p.host, "command", { action: "seek", position: 5 });
    await until(() => p.guestVlc.seeks.includes(5), "backward seek", 750);
    await sleep(150);
    await api(p.host, "command", { action: "pause" });
    await until(() => !p.guestVlc.playing, "host pause", 750);
    await sleep(150);
    await api(p.host, "command", { action: "seek", position: 2 });
    await until(() => p.guestVlc.seeks.includes(2), "paused seek", 750);
    assert.equal(p.hostVlc.playing, false);
    assert.equal(p.guestVlc.playing, false);
    assert.equal((await api(p.host, "state")).room.playback.playing, false);
  } finally { await p.close(); }
});

test("a native VLC seek while automatically held resumes the group without seeking the host twice", { timeout: 15000 }, async () => {
  const p = await party();
  try {
    p.guestVlc.stall(20000);
    await until(async () => (await api(p.host, "state")).waiting, "automatic hold");
    p.hostVlc.nativeSeek(40);
    await until(() => p.guestVlc.seeks.some(position => Math.abs(position - 40) < 0.2), "native host seek propagates", 2000);
    assert.equal(p.hostVlc.playing, true);
    assert.equal(p.guestVlc.playing, true);
    assert.equal(p.hostVlc.seeks.length, 0, "do not re-seek the host after its native seek");
  } finally { await p.close(); }
});

test("a slow VLC control response does not turn normal host playback into a seek", { timeout: 12000 }, async () => {
  const p = await party();
  try {
    await sleep(1200);
    const guestSeeks = p.guestVlc.seeks.length;
    p.hostVlc.statusDelay = 3300;
    await until(() => p.hostVlc.statusDelay === 0, "delayed host status starts");
    await sleep(4300);
    assert.equal(p.hostVlc.seeks.length, 0);
    assert.equal(p.guestVlc.seeks.length, guestSeeks);
    assert.equal((await api(p.host, "state")).room.playback.seekRevision, 0);
  } finally { await p.close(); }
});

test("seeks reject pre-seek telemetry and older clients cannot silently use the old synchronization policy", async () => {
  const server = await startSyncServer(0);
  const sockets: Socket[] = [];
  try {
    const created = await (await fetch(`${server.origin}/rooms`, {
      method: "POST", headers: { Authorization: `Bearer ${server.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(media)
    })).json() as { roomId: string; hostKey: string; guestKey: string };
    const connect = (ticket: string, version = protocolVersion) => {
      const socket = io(server.origin, { transports: ["websocket"], reconnection: false,
        auth: { roomId: created.roomId, ticket, protocolVersion: version, clientId: randomUUID() } });
      sockets.push(socket);
      return socket;
    };
    const old = connect(created.guestKey, 1);
    await new Promise<void>((resolve, reject) => {
      old.once("connect_error", error => { assert.match(error.message, /Update/); resolve(); });
      old.once("connect", () => reject(new Error("Legacy client unexpectedly connected")));
    });
    const host = connect(created.hostKey);
    let latest: Snapshot | undefined;
    host.on("snapshot", value => { latest = value; });
    const guest = connect(created.guestKey);
    await until(() => Boolean(host.connected && guest.connected && latest?.participants === 2), "two protocol-compatible viewers");
    await host.timeout(1000).emitWithAck("command", { action: "play", position: 0, revision: 0 });
    host.emit("progress", { position: 10, revision: 1 });
    guest.emit("progress", { position: 0, revision: 1 });
    await until(() => latest!.waiting.length === 1, "ahead viewer held");
    await sleep(100);
    const result = await host.timeout(1000).emitWithAck("command", { action: "seek", position: 50, revision: 1 });
    assert.equal(result.error, undefined);
    await until(() => latest!.playback.seekPosition === 50, "seek revision");
    host.emit("progress", { position: 50, revision: 2 });
    guest.emit("progress", { position: 0, revision: 1 });
    await sleep(100);
    assert.deepEqual(latest!.waiting, [], "stale guest position must not hold the host after seeking");
    guest.emit("progress", { position: 50, revision: 2 });
    await sleep(250);
    host.emit("progress", { position: 60, revision: 2 });
    await until(() => latest!.waiting.length === 1, "post-seek drift still coordinated");
    guest.disconnect();
    await until(() => latest!.participants === 1 && latest!.waiting.length === 0, "disconnected guest releases hold");
  } finally { for (const socket of sockets) socket.disconnect(); await server.close(); }
});
