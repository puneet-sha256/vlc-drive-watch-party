import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startCompanion } from "./companion.js";
import { GoogleDrive } from "./drive.js";
import { findVlc, Vlc } from "./vlc.js";
import { DevTunnel } from "./tunnel.js";
import { prepareHostingTool } from "./hosting-tool.js";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataRoot = process.env.WATCH_PARTY_DATA_DIR || join(process.env.LOCALAPPDATA || "", "DriveWatchParty");
const emit = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const configSchema = z.object({
  clientId: z.string().endsWith(".apps.googleusercontent.com"),
  clientSecret: z.string().optional(), apiKey: z.string().min(20), appId: z.string().regex(/^\d+$/)
}).strict();
let shutdown: () => Promise<void> = async () => { process.exit(0); };
async function run() {
  const config = configSchema.safeParse(JSON.parse(await readFile(join(appRoot, "app-config.json"), "utf8")));
  if (!config.success) throw new Error("Installer application configuration is missing or invalid. Reinstall Watch Party.");
  const port = Number(process.env.WATCH_PARTY_PORT || 43821);
  const syncPort = Number(process.env.WATCH_PARTY_SYNC_PORT || 43822);
  if (![port, syncPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)) {
    throw new Error("Watch Party ports must be between 1024 and 65535.");
  }
  const google = new GoogleDrive({ ...config.data, redirect: `http://127.0.0.1:${port}/oauth/callback` });
  const vlc = new Vlc(findVlc);
  const tunnelPath = join(dataRoot, "tools", "devtunnel.exe");
  const tunnel = new DevTunnel(tunnelPath, join(dataRoot, "tunnel.json"), {
    prepare: signal => prepareHostingTool(tunnelPath, signal)
  });
  const companion = await startCompanion({
    port, syncPort, google, drive: google, vlc, tunnel,
    apiKey: config.data.apiKey, appId: config.data.appId, onQuit: () => { void shutdown(); }
  });
  let closing = false;
  shutdown = async () => {
    if (closing) return;
    closing = true;
    emit({ type: "closing" });
    tunnel.close(); vlc.dispose();
    const deadline = setTimeout(() => process.exit(0), 5000);
    await companion.close().catch(() => {});
    clearTimeout(deadline);
    process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", chunk => {
    input += chunk;
    const lines = input.split("\n"); input = lines.pop() || "";
    for (const line of lines) if (line.trim() === "quit") void shutdown();
  });
  process.stdin.on("end", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  // This private parent-process IPC is consumed by the launcher, never written to a log.
  emit({ type: "ready", url: companion.launchUrl });
  void tunnel.refreshAccount();
}
void run().catch(error => {
  const message = error?.code === "EADDRINUSE"
    ? "Watch Party's local port is already in use. Close the other companion instance, then launch again."
    : "Watch Party could not start. Repair or reinstall the application and check the local ports.";
  emit({ type: "error", message });
  process.exit(1);
});
