import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { DevTunnel } from "../dist/tunnel.js";
import { prepareHostingTool } from "../dist/hosting-tool.js";
import { startSyncServer } from "../dist/sync-server.js";
import { protocolVersion } from "../dist/protocol.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to create and delete a temporary tunnel using your existing CLI sign-in.");
const directory = await mkdtemp(join(tmpdir(), "watch-party-live-tunnel-"));
const executable = join(directory, "devtunnel.exe");
const settings = join(directory, "tunnel.json");
let sync, tunnel, socket;
async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", () => {});
    child.once("error", () => reject(new Error("The test cleanup command could not start.")));
    child.once("close", code => code === 0 ? resolve(output) : reject(new Error("The test cleanup command failed.")));
  });
}
try {
  await prepareHostingTool(executable, new AbortController().signal);
  console.log("Official hosting-tool download passed the pinned SHA-256 check.");
  sync = await startSyncServer(0);
  tunnel = new DevTunnel(executable, settings);
  await tunnel.refreshAccount();
  assert.equal(tunnel.status.authenticated, true, "Live hosting requires an existing Dev Tunnel CLI sign-in.");
  const port = Number(new URL(sync.origin).port);
  const origin = await tunnel.start(port);
  const headers = { "X-Tunnel-Skip-AntiPhishing-Page": "true" };
  const created = await (await fetch(`${sync.origin}/rooms`, {
    method: "POST", headers: { Authorization: `Bearer ${sync.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fileId: "synthetic-tunnel-check", name: "synthetic.mkv", size: 123, mimeType: "video/x-matroska" })
  })).json();
  assert.equal((await fetch(`${origin}/health`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/media/anything`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/oauth/callback`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/rooms/${created.roomId}`, { headers })).status, 403);
  socket = io(origin, {
    transports: ["websocket"], extraHeaders: headers,
    auth: { roomId: created.roomId, ticket: created.guestKey, clientId: "11111111-1111-4111-8111-111111111111", protocolVersion }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public WSS timed out.")), 15000);
    socket.once("snapshot", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", () => { clearTimeout(timer); reject(new Error("Public WSS was rejected.")); });
  });
  const denied = await socket.timeout(5000).emitWithAck("command", { action: "play", position: 0, revision: 0 });
  assert.match(denied.error, /Only the host/);
  socket.disconnect();
  tunnel.stop();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(await tunnel.start(port), origin, "The saved dedicated tunnel should be reused.");
  console.log("Real HTTPS/WSS hosting, guest restrictions, sync-only routing, stop and tunnel reuse passed.");
} finally {
  socket?.disconnect();
  tunnel?.close();
  await sync?.close();
  let id;
  try { id = JSON.parse(await readFile(settings, "utf8")).tunnelId; } catch {}
  if (id) {
    assert.match(id, /^drive-watch-party-[a-f0-9]{12}\.[a-z0-9]+$/);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await command(["delete", id, "--force", "--json"]);
    console.log("Deleted the test-created cloud tunnel.");
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
