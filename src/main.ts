import "dotenv/config";
import { spawn } from "node:child_process";
import { startCompanion } from "./companion.js";
import { GoogleDrive } from "./drive.js";
import { findVlc, Vlc } from "./vlc.js";

const port = Number(process.env.COMPANION_PORT || 43821);
const google = new GoogleDrive({
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
  redirect: `http://127.0.0.1:${port}/oauth/callback`
});
const companion = await startCompanion({
  port, drive: google, google, vlc: new Vlc(await findVlc()),
  syncPort: Number(process.env.SYNC_PORT || 43822),
  publicSyncUrl: process.env.PUBLIC_SYNC_URL,
  apiKey: process.env.GOOGLE_API_KEY, appId: process.env.GOOGLE_APP_ID
});
console.log(`VLC companion listening at ${companion.origin}. Opening its authorized local window.`);
if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", companion.launchUrl], { stdio: "ignore" });
else spawn(process.platform === "darwin" ? "open" : "xdg-open", [companion.launchUrl], { stdio: "ignore" });
const shutdown = async () => { await companion.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
