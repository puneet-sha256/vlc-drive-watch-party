import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { io } from "socket.io-client";
import { startCompanion } from "../src/companion.js";
import { findVlc, Vlc } from "../src/vlc.js";
import { parseInvite, protocolVersion, type Media } from "../src/protocol.js";
import type { Drive } from "../src/drive.js";
import type { ManagedTunnel } from "../src/tunnel.js";

const require = createRequire(import.meta.url);
async function until(fn: () => Promise<boolean>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "vlc-party-test-"));
  const path = join(dir, "test.mkv");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(require("ffmpeg-static"), [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=36",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=36", "-f", "srt", "-i", "pipe:0",
        "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25",
        "-c:a", "flac", "-c:s", "ass", "-metadata:s:s:0", "language=eng", "-y", path
      ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let error = "";
      child.stderr.on("data", data => { error += data.toString(); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(error)));
      child.stdin.end("1\n00:00:01,000 --> 00:00:35,000\nLocal VLC subtitle\n");
    });
    return await readFile(path);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(dir);
  }
}
class FakeDrive implements Drive {
  reads = 0;
  metadataValue: Media;
  constructor(private data: Buffer) {
    this.metadataValue = { fileId: "same-original-file", name: "test.mkv", mimeType: "video/x-matroska", size: data.length };
  }
  async metadata(fileId: string) { assert.equal(fileId, this.metadataValue.fileId); return this.metadataValue; }
  async open(fileId: string, range?: string) {
    assert.equal(fileId, this.metadataValue.fileId);
    this.reads++;
    let start = 0, end = this.data.length - 1;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : Math.max(0, this.data.length - Number(match[2]));
      if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start > end) return new Response(null, { status: 416 });
    return new Response(new Uint8Array(this.data.subarray(start, end + 1)), {
      status: range ? 206 : 200, headers: {
        "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${this.data.length}` } : {})
      }
    });
  }
}
test("two actual VLC clients use separate media bridges and synchronize through a media-free server", { timeout: 90000 }, async () => {
  const data = await fixture();
  const hostDrive = new FakeDrive(data), guestDrive = new FakeDrive(data);
  const path = await findVlc();
  const hostVlc = new Vlc(path, true), guestVlc = new Vlc(path, true);
  let hostStarts = 0;
  const hostTunnel: ManagedTunnel = {
    status: { state: "ready", authenticated: true },
    login() {}, cancelLogin() {}, stop() {}, close() {},
    async start(port) { hostStarts++; return `http://127.0.0.1:${port}`; }
  };
  const guestTunnel: ManagedTunnel = {
    ...hostTunnel, status: { state: "signed-out", authenticated: false },
    login() { throw new Error("Guests must not need a tunnel login."); },
    async start() { throw new Error("Guests must not start a tunnel."); }
  };
  const host = await startCompanion({ port: 0, syncPort: 0, drive: hostDrive, vlc: hostVlc, tunnel: hostTunnel });
  const guest = await startCompanion({ port: 0, syncPort: 0, drive: guestDrive, vlc: guestVlc, tunnel: guestTunnel });
  async function api(client: typeof host, path: string, body?: unknown) {
    const response = await fetch(`${client.origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${client.localKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    assert.equal((await fetch(`${host.origin}/api/state`)).status, 403);
    assert.equal((await fetch(`${host.origin}/media/bad-capability`)).status, 403);
    assert.equal((await fetch(`${host.origin}/api/state`, { headers: {
      Authorization: `Bearer ${host.localKey}`, Origin: "https://untrusted.example"
    } })).status, 403);
    await api(host, "select", { fileId: "same-original-file" });
    const { invite } = await api(host, "host", {});
    await api(guest, "join", { invite });
    assert.equal(hostStarts, 1);
    const parsed = parseInvite(invite);
    assert.equal((await fetch(`${parsed.origin}/media/anything`)).status, 404);
    assert.equal((await fetch(`${parsed.origin}/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hostDrive.metadataValue) })).status, 403);
    const outsider = io(parsed.origin, { auth: { ...parsed, protocolVersion, clientId: "11111111-1111-4111-8111-111111111111" }, transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => { outsider.once("snapshot", () => resolve()); outsider.once("connect_error", reject); });
    const denied = await outsider.timeout(3000).emitWithAck("command", { action: "play", position: 0, revision: 0 });
    assert.match(denied.error, /Only the host/);
    outsider.disconnect();
    await until(async () => (await hostVlc.status()).duration > 30 && (await guestVlc.status()).duration > 30, "VLC metadata");
    await api(host, "command", { action: "play" });
    await until(async () => (await guestVlc.status()).position > 2, "guest playback advances");
    await until(async () => Math.abs((await hostVlc.status()).position - (await guestVlc.status()).position) < 3, "playing drift");
    const decoded = await guestVlc.status();
    assert.ok(decoded.raw.stats.decodedvideo > 0, "VLC decoded actual video frames");
    assert.match(JSON.stringify(decoded.raw.information), /Subtitle/i, "VLC recognized the embedded subtitle stream");
    assert.ok(hostDrive.reads > 0 && guestDrive.reads > 0, "each viewer opened its own source");
    await api(host, "command", { action: "seek", position: 20 });
    await until(async () => (await guestVlc.status()).position >= 19.5, "seek while playing");
    const revision = (await api(host, "state")).room.playback.revision;
    await guestVlc.seek(15, (await guestVlc.status()).duration);
    let correctiveSeeks = 0;
    const guestSeek = guestVlc.seek.bind(guestVlc);
    guestVlc.seek = async (position, duration) => { correctiveSeeks++; await guestSeek(position, duration); };
    await until(async () => (await api(host, "state")).waiting && !(await hostVlc.status()).playing, "ahead real VLC host waits");
    assert.equal((await guestVlc.status()).playing, true, "the behind VLC must keep playing");
    await until(async () => !(await api(host, "state")).waiting && (await hostVlc.status()).playing, "real VLC host resumes after catch-up");
    assert.equal(correctiveSeeks, 0, "real VLC catch-up must not seek the guest forward");
    assert.equal((await api(host, "state")).room.playback.revision, revision, "real VLC automatic hold must not broadcast a pause");
    guestVlc.seek = guestSeek;
    await new Promise(r => setTimeout(r, 2000));
    await hostVlc.pause();
    await until(async () => !(await guestVlc.status()).playing, "native host VLC pause propagates");
    assert.ok(Math.abs((await hostVlc.status()).position - (await guestVlc.status()).position) < 3, "pause preserves the allowed drift without seeking");
    await api(host, "command", { action: "seek", position: 8 });
    await until(async () => Math.abs((await guestVlc.status()).position - 8) < 0.6, "paused backward seek");
    assert.equal((await guestVlc.status()).playing, false);
    const previousInput = (await guestVlc.status()).raw.currentplid;
    await api(guest, "leave", {});
    await api(guest, "join", { invite });
    const newInput = (await guestVlc.status()).raw.currentplid;
    assert.notEqual(newInput, previousInput, "rejoin must wait for the replacement VLC input");
    await until(async () => {
      const state = await guestVlc.status();
      return state.raw.currentplid === newInput && !state.playing && Math.abs(state.position - 8) < 0.6;
    }, "rejoin current snapshot");
    await new Promise(resolve => setTimeout(resolve, 1500));
    const settled = await guestVlc.status();
    assert.equal(settled.raw.currentplid, newInput);
    assert.equal(settled.playing, false);
    assert.ok(Math.abs(settled.position - 8) < 0.6, "rejoined input must remain at the host's paused position");
    await api(host, "command", { action: "play" });
    await until(async () => (await guestVlc.status()).playing, "resumed guest");
    await host.close();
    await until(async () => !(await guestVlc.status()).playing, "guest pauses when server disappears");
  } finally {
    await guest.close();
    await host.close().catch(() => {});
  }
});
