import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TunnelStatus {
  state: "checking" | "signed-out" | "ready" | "signing-in" | "starting" | "hosting" | "error";
  authenticated: boolean;
  origin?: string;
  loginUrl?: string;
  userCode?: string;
  message?: string;
}
export interface ManagedTunnel {
  readonly status: TunnelStatus;
  login(provider: "microsoft" | "github"): void;
  cancelLogin(): void;
  start(port: number): Promise<string>;
  stop(): void;
  close(): void;
}
export function devicePrompt(text: string): { loginUrl: string; userCode: string } | undefined {
  text = text.replace(/\x1b\[[0-9;]*m/g, "");
  const url = text.match(/https:\/\/(?:microsoft\.com\/devicelogin|login\.microsoft\.com\/device|aka\.ms\/devicelogin|github\.com\/login\/device)\b/i)?.[0];
  const code = text.match(/\b(?:[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{9})\b/)?.[0];
  return url && code ? { loginUrl: url, userCode: code } : undefined;
}
export function hostedOrigin(text: string, port: number): string | undefined {
  for (const match of text.matchAll(/https:\/\/[a-z0-9.-]+\.devtunnels\.ms\b/gi)) {
    const url = new URL(match[0]);
    if (url.hostname.split(".")[0]?.endsWith(`-${port}`)) return url.origin;
  }
  return undefined;
}
function tunnelObject(raw: string): any {
  try {
    // The CLI can print a service notice before its --json result.
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return parsed.tunnel ?? parsed;
  } catch { throw new Error("Dev Tunnel returned an unreadable response."); }
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9.-]{1,120}$/i.test(value);

export class DevTunnel implements ManagedTunnel {
  public status: TunnelStatus = { state: "checking", authenticated: false };
  private host?: ChildProcess;
  private auth?: ChildProcess;
  private pending?: Promise<string>;
  private generation = 0;
  private closed = false;
  private authentication?: AbortController;
  private commands = new Set<ChildProcess>();
  public constructor(private readonly executable: string, private readonly settingsFile: string,
    private readonly options: { prepare?: (signal: AbortSignal) => Promise<void>; spawn?: typeof spawn } = {}) {}
  private launch(args: string[]) {
    return (this.options.spawn || spawn)(this.executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }

  private command(args: string[], timeout = 60000): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Watch Party is shutting down."));
    return new Promise((resolve, reject) => {
      const child = this.launch(args);
      this.commands.add(child);
      let output = "", size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error("Dev Tunnel timed out. Check your connection and try again.")); }, timeout);
      child.stdout!.on("data", chunk => {
        output += chunk.toString(); size += chunk.length;
        if (size > 1048576) child.kill();
      });
      // CLI diagnostics may contain credentials; never forward them to the UI or logs.
      child.stderr!.on("data", chunk => { size += chunk.length; if (size > 1048576) child.kill(); });
      child.once("error", () => {
        clearTimeout(timer); this.commands.delete(child);
        reject(new Error("Dev Tunnel could not start. Repair or reinstall Watch Party."));
      });
      child.once("close", code => {
        clearTimeout(timer); this.commands.delete(child);
        if (code === 0 && size <= 1048576) resolve(output);
        else reject(new Error("Dev Tunnel failed. Check network access, account permissions, and sign in again if needed."));
      });
    });
  }
  public async refreshAccount(): Promise<void> {
    if (this.closed || this.authentication) return;
    try {
      const account = tunnelObject(await this.command(["user", "show", "--json"], 60000));
      const authenticated = account.status === "Logged in";
      if (!this.closed && !this.authentication) this.status = { state: authenticated ? "ready" : "signed-out", authenticated };
    } catch {
      if (!this.closed && !this.authentication) this.status = { state: "signed-out", authenticated: false };
    }
  }
  public login(provider: "microsoft" | "github"): void {
    if (this.closed) throw new Error("Watch Party is shutting down.");
    if (this.host || this.pending) throw new Error("Leave the hosted party before changing the tunnel account.");
    if (this.authentication) return;
    const abort = new AbortController();
    this.authentication = abort;
    this.status = { state: "signing-in", authenticated: false, message: "Preparing hosting tools and requesting a sign-in code..." };
    void (async () => {
      await this.options.prepare?.(abort.signal);
      if (abort.signal.aborted || this.closed) return;
      const account = tunnelObject(await this.command(["user", "show", "--json"]));
      if (abort.signal.aborted || this.closed) return;
      if (account.status === "Logged in") {
        this.authentication = undefined;
        this.status = { state: "ready", authenticated: true, message: "Using your existing Dev Tunnel sign-in. Hosting is ready." };
        return;
      }
      this.beginLogin(provider, abort);
    })().catch(() => {
      if (this.authentication !== abort) return;
      this.authentication = undefined;
      this.status = { state: "error", authenticated: false, message: "Hosting setup failed. Check your connection and try again." };
    });
  }
  private beginLogin(provider: "microsoft" | "github", abort: AbortController): void {
    const child = this.launch([
      "user", "login", "--use-device-code-auth", provider === "github" ? "--github" : "--entra", "--json"
    ]);
    this.auth = child;
    let text = "";
    const collect = (chunk: Buffer) => {
      text = (text + chunk.toString()).slice(-8192);
      const prompt = devicePrompt(text);
      if (prompt && this.auth === child) this.status = {
        state: "signing-in", authenticated: false, ...prompt,
        message: "Open the sign-in page and enter this code. Never send the code to anyone."
      };
    };
    child.stdout!.on("data", collect); child.stderr!.on("data", collect);
    const timer = setTimeout(() => child.kill(), 600000);
    const failed = () => {
      if (this.auth !== child) return;
      this.auth = undefined;
      this.authentication = undefined;
      this.status = { state: "error", authenticated: false, message: "Tunnel sign-in did not complete. Try again." };
    };
    child.once("error", () => { clearTimeout(timer); failed(); });
    child.once("close", code => {
      clearTimeout(timer);
      if (this.auth !== child) return;
      if (code !== 0) { failed(); return; }
      this.auth = undefined;
      if (this.authentication === abort) this.authentication = undefined;
      void this.refreshAccount();
    });
  }
  public cancelLogin(): void {
    if (!this.authentication && !this.auth) return;
    this.authentication?.abort(); this.authentication = undefined;
    const child = this.auth; this.auth = undefined; child?.kill();
    this.status = { state: "signed-out", authenticated: false, message: "Sign-in cancelled. You can retry or join as a guest." };
  }
  public start(port: number): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Watch Party is shutting down."));
    if (this.status.state === "hosting" && this.status.origin) return Promise.resolve(this.status.origin);
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this.startCore(port, generation).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async startCore(port: number, generation: number): Promise<string> {
    if (this.authentication) throw new Error("Complete the tunnel sign-in first.");
    await this.refreshAccount();
    if (!this.status.authenticated) throw new Error("Hosting needs Microsoft or GitHub sign-in in Hosting setup. Guests do not need this.");
    this.status = { state: "starting", authenticated: true, message: "Preparing your sync-only tunnel..." };
    try {
      let id: string | undefined;
      try {
        const saved = JSON.parse(await readFile(this.settingsFile, "utf8"));
        if (validId(saved.tunnelId) && saved.port === port) {
          const existing = tunnelObject(await this.command(["show", saved.tunnelId, "--json"]));
          if (existing.ports?.length !== 1 || existing.ports[0]?.portNumber !== port) {
            throw new Error("Not a single-port sync tunnel.");
          }
          id = saved.tunnelId;
        }
      } catch { /* An expired, unavailable, or differently configured tunnel is not reused. */ }
      if (generation !== this.generation) throw new Error("Tunnel startup cancelled.");
      if (!id) {
        const name = `drive-watch-party-${randomBytes(6).toString("hex")}`;
        const created = tunnelObject(await this.command([
          "create", name, "--allow-anonymous", "--expiration", "30d",
          "--description", "Watch Party synchronization only", "--json"
        ]));
        const createdId: unknown = created.tunnelId;
        if (!validId(createdId)) throw new Error("Dev Tunnel did not return a valid tunnel ID.");
        id = createdId;
        try {
          await this.command(["port", "create", id, "-p", String(port), "--protocol", "http", "--json"]);
        } catch (error) {
          await this.command(["delete", id, "--force", "--json"]).catch(() => {});
          throw error;
        }
        await mkdir(dirname(this.settingsFile), { recursive: true });
        await writeFile(this.settingsFile, JSON.stringify({ tunnelId: id, port }), { mode: 0o600 });
      }
      if (generation !== this.generation) throw new Error("Tunnel startup cancelled.");
      const origin = await this.hostTunnel(id, port);
      for (let attempt = 0; attempt < 12; attempt++) {
        if (generation !== this.generation) throw new Error("Tunnel startup cancelled.");
        try {
          const response = await fetch(`${origin}/health`, {
            headers: { "X-Tunnel-Skip-AntiPhishing-Page": "true" }, signal: AbortSignal.timeout(5000)
          });
          if (response.ok && (await response.json() as any).role === "sync-only" && this.host) {
            this.status = { state: "hosting", authenticated: true, origin };
            return origin;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error("The tunnel started but the public sync service is not reachable.");
    } catch (error) {
      this.stop();
      this.status = { state: "error", authenticated: true, message: error instanceof Error ? error.message : "Tunnel startup failed." };
      throw error;
    }
  }
  private hostTunnel(id: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.launch(["host", id]);
      this.host = child;
      let buffer = "", ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error("The tunnel relay did not become ready.")); }, 60000);
      const collect = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-8192);
        const origin = hostedOrigin(buffer, port);
        if (!ready && origin) { ready = true; clearTimeout(timer); resolve(origin); }
      };
      child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Could not run Dev Tunnel.")); });
      child.once("close", () => {
        clearTimeout(timer);
        if (this.host === child) {
          this.host = undefined;
          this.status = { state: "error", authenticated: true, message: "The sync tunnel stopped. Leave and recreate the party to restart it." };
        }
        if (!ready) reject(new Error("The sync tunnel could not connect."));
      });
    });
  }
  public stop(): void {
    this.generation++;
    const child = this.host; this.host = undefined; child?.kill();
    if (!this.authentication) this.status = { state: this.status.authenticated ? "ready" : "signed-out", authenticated: this.status.authenticated };
  }
  public close(): void {
    this.closed = true;
    this.stop();
    this.authentication?.abort(); this.authentication = undefined;
    const auth = this.auth; this.auth = undefined; auth?.kill();
    for (const command of this.commands) command.kill();
  }
}
