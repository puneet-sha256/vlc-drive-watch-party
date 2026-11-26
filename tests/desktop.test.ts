import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevTunnel, devicePrompt, hostedOrigin, type ManagedTunnel } from "../src/tunnel.js";
import { prepareHostingTool } from "../src/hosting-tool.js";
import { startCompanion } from "../src/companion.js";
import { Vlc } from "../src/vlc.js";
import type { Drive } from "../src/drive.js";

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("State change timed out.");
}
function cli() {
  let authenticated = true, port = 45678;
  const commands: string[][] = [];
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: boolean; kill(): boolean }> = [];
  const launch = ((_executable: string, args: string[]) => {
    commands.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; queueMicrotask(() => this.emit("close", 1)); return true; }
    });
    children.push(child);
    queueMicrotask(() => {
      if (args[0] === "host") {
        child.stdout.write(`Connect via browser: https://fixture-${port}.inc1.devtunnels.ms\n`);
        return;
      }
      if (args[0] === "user" && args[1] === "login") {
        child.stderr.write("To sign in, use https://microsoft.com/devicelogin and enter the code ABCD");
        child.stderr.write("EF123 to authenticate. PRIVATE-DIAGNOSTIC-MUST-NOT-LEAK");
        return;
      }
      if (args[0] === "port") port = Number(args[args.indexOf("-p") + 1]);
      const result = args[0] === "user" ? { status: authenticated ? "Logged in" : "Not logged in" }
        : { tunnel: { tunnelId: "fixture.inc1", ports: [{ portNumber: port }] } };
      child.stdout.end("Dev Tunnel service notice\n" + JSON.stringify(result)); child.emit("close", 0);
    });
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  return { launch, commands, children, setAuthenticated: (value: boolean) => { authenticated = value; } };
}

test("device authentication exposes only official provider prompts and the requested sync-port origin", () => {
  assert.deepEqual(devicePrompt("https://microsoft.com/devicelogin enter code ABCDEF123"), {
    loginUrl: "https://microsoft.com/devicelogin", userCode: "ABCDEF123"
  });
  assert.deepEqual(devicePrompt("Use https://login.microsoft.com/device and enter the code ABCDEF123"), {
    loginUrl: "https://login.microsoft.com/device", userCode: "ABCDEF123"
  });
  assert.deepEqual(devicePrompt("Visit https://github.com/login/device and use \x1b[32mABCD-EF12\x1b[0m"), {
    loginUrl: "https://github.com/login/device", userCode: "ABCD-EF12"
  });
  assert.equal(devicePrompt("https://untrusted.example/device code ABCD-EF12"), undefined);
  assert.equal(hostedOrigin("https://fixture-43821.inc1.devtunnels.ms https://fixture-43822-inspect.inc1.devtunnels.ms", 43822), undefined);
  assert.equal(hostedOrigin("https://fixture-43822.inc1.devtunnels.ms", 43822), "https://fixture-43822.inc1.devtunnels.ms");
});

test("managed hosting creates only a sync port, reuses its saved tunnel, and closes its owned host", async t => {
  const directory = await mkdtemp(join(tmpdir(), "watch-party-tunnel-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = cli();
  const manager = new DevTunnel("fixture", join(directory, "tunnel.json"), { spawn: fake.launch });
  t.after(() => manager.close());
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ready: true, role: "sync-only" });
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await manager.start(45678), "https://fixture-45678.inc1.devtunnels.ms");
  assert.equal(fake.commands.filter(args => args[0] === "create").length, 1);
  assert.deepEqual(fake.commands.find(args => args[0] === "port")?.slice(0, 6), ["port", "create", "fixture.inc1", "-p", "45678", "--protocol"]);
  const settings = JSON.parse(await readFile(join(directory, "tunnel.json"), "utf8"));
  assert.deepEqual(settings, { tunnelId: "fixture.inc1", port: 45678 });
  const firstHost = fake.children.at(-1)!;
  manager.cancelLogin();
  assert.equal(manager.status.state, "hosting", "a stale cancel request must not invalidate a running tunnel");
  manager.stop();
  assert.equal(firstHost.killed, true);
  await manager.start(45678);
  assert.equal(fake.commands.filter(args => args[0] === "create").length, 1);
  assert.equal(fake.commands.filter(args => args[0] === "host").length, 2);
  manager.close();
  assert.equal(fake.children.at(-1)!.killed, true);
  await assert.rejects(manager.start(45678), /shutting down/);
});

test("fresh sign-in supports split prompts, cancellation, retry and does not expose CLI diagnostics", async () => {
  const fake = cli();
  const manager = new DevTunnel("fixture", "unused", { spawn: fake.launch });
  try {
    fake.setAuthenticated(false);
    await assert.rejects(manager.start(45678), /sign-in/);
    assert.equal(fake.commands.some(args => args[0] === "create"), false);
    manager.login("microsoft");
    await until(() => Boolean(manager.status.userCode));
    assert.equal(manager.status.userCode, "ABCDEF123");
    assert.equal(JSON.stringify(manager.status).includes("PRIVATE-DIAGNOSTIC"), false);
    const login = fake.children.at(-1)!;
    manager.cancelLogin();
    assert.equal(login.killed, true);
    assert.equal(manager.status.userCode, undefined);
    manager.login("github");
    await until(() => fake.commands.some(args => args.includes("--github")));
    fake.setAuthenticated(true);
    fake.children.at(-1)!.emit("close", 0);
    await until(() => manager.status.state === "ready");
    assert.equal(manager.status.authenticated, true);
  } finally { manager.close(); }
});

test("cancelling tool preparation prevents a late authentication process from starting", async () => {
  let complete!: () => void;
  const fake = cli();
  const manager = new DevTunnel("fixture", "unused", {
    spawn: fake.launch, prepare: () => new Promise<void>(resolve => { complete = resolve; })
  });
  manager.login("microsoft");
  manager.cancelLogin();
  complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.commands.length, 0);
  assert.equal(manager.status.state, "signed-out");
  manager.close();
});

test("a failed authentication process can be retried without keeping its device code", async () => {
  const fake = cli();
  fake.setAuthenticated(false);
  const manager = new DevTunnel("fixture", "unused", { spawn: fake.launch });
  try {
    manager.login("microsoft");
    await until(() => Boolean(manager.status.userCode));
    fake.children.at(-1)!.emit("close", 1);
    assert.equal(manager.status.state, "error");
    assert.equal(manager.status.userCode, undefined);
    manager.login("microsoft");
    await until(() => Boolean(manager.status.userCode));
    assert.equal(manager.status.state, "signing-in");
  } finally { manager.close(); }
});

test("hosting setup reuses a cached CLI sign-in instead of replacing it with a device login", async () => {
  const fake = cli();
  const manager = new DevTunnel("fixture", "unused", { spawn: fake.launch });
  try {
    manager.login("microsoft");
    await until(() => manager.status.state === "ready");
    assert.equal(manager.status.authenticated, true);
    assert.equal(fake.commands.some(args => args[0] === "user" && args[1] === "login"), false);
  } finally { manager.close(); }
});

test("an unverified hosting-tool download is rejected and its temporary executable is removed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "watch-party-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("not the signed Microsoft executable");
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(prepareHostingTool(join(directory, "devtunnel.exe"), new AbortController().signal), /verified/);
  assert.deepEqual(await readdir(directory), []);
});

test("missing VLC still permits desktop setup, and local tunnel controls require authorization", async () => {
  let logins = 0, cancels = 0, quits = 0;
  const manager: ManagedTunnel = {
    status: { state: "signed-out", authenticated: false },
    login() { logins++; }, cancelLogin() { cancels++; },
    async start() { throw new Error("A guest must not start a tunnel."); }, stop() {}, close() {}
  };
  const drive: Drive = { async metadata() { throw new Error("unused"); }, async open() { throw new Error("unused"); } };
  const vlc = new Vlc(async () => { throw new Error("VLC is not installed."); });
  const companion = await startCompanion({ port: 0, drive, vlc, tunnel: manager, onQuit: () => { quits++; } });
  try {
    assert.equal((await fetch(companion.origin)).status, 200);
    assert.equal(logins, 0, "opening the app must not sign in to hosting");
    const headers = { Authorization: `Bearer ${companion.localKey}`, "Content-Type": "application/json" };
    const state = await (await fetch(`${companion.origin}/api/state`, { headers })).json() as any;
    assert.equal(state.vlcAvailable, false);
    assert.equal(state.canQuit, true);
    assert.equal((await fetch(`${companion.origin}/api/tunnel/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"provider":"microsoft"}' })).status, 403);
    assert.equal(logins, 0);
    await fetch(`${companion.origin}/api/tunnel/login`, { method: "POST", headers, body: '{"provider":"microsoft"}' });
    await fetch(`${companion.origin}/api/tunnel/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(logins, 1); assert.equal(cancels, 1);
    await fetch(`${companion.origin}/api/quit`, { method: "POST", headers, body: "{}" });
    await until(() => quits === 1);
  } finally { await companion.close(); }
  await assert.rejects(vlc.start(), /shutting down/);
});

class LoadingVlc extends Vlc {
  commands: string[] = [];
  reads = 0;
  switched = false;
  keepOldInput = false;
  onOpen?: () => void;
  onRead?: () => void;
  private opening = false;
  private paused = false;
  constructor() { super("synthetic-only"); }
  override async start() {}
  override async request(command?: string) {
    if (command) this.commands.push(command);
    if (command === "in_play") { this.opening = true; this.onOpen?.(); }
    if (command === "pl_forcepause") {
      assert.equal(this.switched, true, "must not pause the stale input");
      this.paused = true;
    }
    if (!command && this.opening) {
      this.onRead?.();
      this.reads++;
      if (!this.keepOldInput && this.reads >= 3) this.switched = true;
    }
    return this.switched
      ? { currentplid: 4, state: this.paused ? "paused" : "playing", length: 36, position: 0 }
      : this.reads === 2 && !this.keepOldInput
        ? { currentplid: 4, state: "opening", length: 0, position: 0 }
        : { currentplid: 3, state: "paused", length: 36, position: 8 / 36 };
  }
}

test("VLC open waits for a new ready input and pauses it before returning", async () => {
  const vlc = new LoadingVlc();
  await vlc.open("http://127.0.0.1/synthetic-media");
  assert.ok(vlc.reads >= 4, "old metadata and an opening input must not satisfy readiness");
  const state = await vlc.status();
  assert.equal(state.raw.currentplid, 4);
  assert.equal(state.playing, false);
  assert.equal(state.position, 0);
  assert.deepEqual(vlc.commands, ["in_play", "pl_forcepause"]);
});

test("VLC open times out rather than accepting old input metadata", async t => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const vlc = new LoadingVlc();
  vlc.keepOldInput = true;
  vlc.onRead = () => { now += 5000; };
  await assert.rejects(vlc.open("http://127.0.0.1/synthetic-media"), /media.*ready/i);
  assert.equal(vlc.commands.includes("pl_forcepause"), false);
});

test("closing VLC during media loading cancels readiness without pausing or resuming it", async () => {
  const vlc = new LoadingVlc();
  vlc.onOpen = () => vlc.dispose();
  await assert.rejects(vlc.open("http://127.0.0.1/synthetic-media"), /cancelled|shutting down/i);
  assert.deepEqual(vlc.commands, ["in_play"]);
});
