import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import { secret } from "./sync-server.js";

export interface PlayerState { playing: boolean; position: number; duration: number; raw: Record<string, any> }
export async function findVlc(): Promise<string> {
  const candidates = [
    process.env.VLC_PATH,
    "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
    "/Applications/VLC.app/Contents/MacOS/VLC", "/usr/bin/vlc"
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new Error("VLC was not found. Install VLC or set VLC_PATH.");
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
export class Vlc {
  private disposed = false;
  private generation = 0;
  private child?: ChildProcess;
  private origin = "";
  private password = secret();
  public constructor(private readonly executable: string | (() => Promise<string>), private readonly headless = false) {}
  private async resolveExecutable(): Promise<string> {
    return typeof this.executable === "string" ? this.executable : this.executable();
  }
  public async available(): Promise<boolean> {
    try { await access(await this.resolveExecutable()); return true; } catch { return false; }
  }
  public async start(): Promise<void> {
    if (this.disposed) throw new Error("VLC companion is shutting down.");
    if (this.child && this.child.exitCode === null) return;
    const executable = await this.resolveExecutable();
    const port = await freePort();
    this.origin = `http://127.0.0.1:${port}`;
    if (this.disposed) throw new Error("VLC companion is shutting down.");
    this.child = spawn(executable, [
      "--no-one-instance", "--extraintf=http", "--http-host=127.0.0.1",
      `--http-port=${port}`, `--http-password=${this.password}`,
      "--no-video-title-show", "--no-loop", "--no-repeat",
      ...(this.headless ? ["-I", "dummy", "--vout=dummy", "--aout=dummy"] : [])
    ], { windowsHide: this.headless, stdio: "ignore" });
    let launchError = false;
    this.child.on("error", () => { launchError = true; });
    for (let i = 0; i < 80; i++) {
      if (this.disposed || launchError || !this.child || this.child.exitCode !== null) throw new Error("VLC could not start.");
      try { await this.status(); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    this.close();
    throw new Error("VLC's local control interface did not become ready.");
  }
  public async request(command?: string, value?: string): Promise<Record<string, any>> {
    const url = new URL(`${this.origin}/requests/status.json`);
    if (command) url.searchParams.set("command", command);
    if (value !== undefined) url.searchParams.set(command === "in_play" ? "input" : "val", value);
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${this.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error("Could not control local VLC.");
    return response.json() as Promise<Record<string, any>>;
  }
  public async status(): Promise<PlayerState> {
    const raw = await this.request();
    const duration = Number(raw.length) || 0;
    return { playing: raw.state === "playing", position: duration ? Number(raw.position) * duration : Number(raw.time) || 0, duration, raw };
  }
  public async open(url: string): Promise<void> {
    await this.start();
    const generation = ++this.generation;
    const checkActive = () => {
      if (this.disposed || generation !== this.generation) throw new Error("VLC media loading was cancelled.");
    };
    try {
      const previousInput = (await this.status()).raw.currentplid;
      checkActive();
      await this.request("in_play", url);
      const deadline = Date.now() + 15000;
      let readyInput: number | undefined;
      while (Date.now() < deadline) {
        checkActive();
        const current = await this.status();
        checkActive();
        const input = current.raw.currentplid;
        const ready = current.duration > 0 && ["playing", "paused"].includes(current.raw.state);
        // in_play may acknowledge while status still describes the previous input.
        if (readyInput === undefined && ready && Number.isInteger(input) && input >= 0 && input !== previousInput) {
          readyInput = input;
          await this.pause();
          checkActive();
        } else if (readyInput !== undefined && input === readyInput && ready && current.raw.state === "paused") {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("VLC's new media did not become ready. Check the file and connection.");
    } catch (error) {
      if (generation === this.generation) this.close();
      throw error;
    }
  }
  public async play(): Promise<void> { await this.request("pl_forceresume"); }
  public async pause(): Promise<void> { await this.request("pl_forcepause"); }
  public async seek(position: number, duration: number): Promise<void> {
    await this.request("seek", duration > 0 ? `${Math.min(100, Math.max(0, position / duration * 100)).toFixed(6)}%` : String(Math.floor(position)));
  }
  public close(): void { this.generation++; this.child?.kill(); this.child = undefined; }
  public dispose(): void { this.disposed = true; this.close(); }
}
