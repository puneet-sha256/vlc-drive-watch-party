import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "dotenv";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "artifacts");
const payload = join(artifacts, "payload");
const app = join(payload, "app");
const exists = path => access(path).then(() => true, () => false);
async function firstExisting(paths) {
  for (const path of paths.filter(Boolean)) if (await exists(path)) return path;
  throw new Error("A packaging prerequisite is missing. See README.md.");
}
function run(file, args) { execFileSync(file, args, { cwd: root, windowsHide: true, stdio: "inherit" }); }
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build this installer on Windows x64.");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const env = parse(await readFile(join(root, ".env")));
  const config = {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    apiKey: env.GOOGLE_API_KEY, appId: env.GOOGLE_APP_ID
  };
  if (!config.clientId?.endsWith(".apps.googleusercontent.com") || !config.apiKey || !/^\d+$/.test(config.appId || "")) {
    throw new Error("Supply the four Desktop Google application settings in .env before packaging. Values will not be printed.");
  }
  const compiler = await firstExisting([
    process.env.INNO_SETUP_COMPILER,
    join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"
  ]);
  const csc = join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await access(csc);
  // Never recursively clean a workspace. Each build gets a fresh, explicitly selected staging directory.
  if (await exists(payload)) throw new Error("artifacts\\payload already exists. Rename it before rebuilding; do not mix old payload files.");
  await mkdir(join(payload, "runtime"), { recursive: true });
  await mkdir(app, { recursive: true });
  run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc")]);
  run(csc, [
    "/nologo", "/target:winexe", "/platform:x64",
    "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
    `/out:${join(payload, "WatchParty.exe")}`, join(root, "packaging", "Launcher.cs")
  ]);
  await cp(process.execPath, join(payload, "runtime", "node.exe"));
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!nodeLicense.ok) throw new Error("Could not retrieve the bundled Node version's license.");
  await writeFile(join(payload, "runtime", "LICENSE"), await nodeLicense.text());
  await cp(join(root, "dist"), join(app, "dist"), { recursive: true });
  await cp(join(root, "web"), join(app, "web"), { recursive: true });
  await cp(join(root, "README.md"), join(app, "README.md"));
  await writeFile(join(app, "app-config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(join(app, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", private: true }));

  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  let packageCount = 0;
  const notices = [
    "VLC Drive Watch Party - third-party notices",
    `Bundled Node.js ${process.version}: runtime\\LICENSE contains its full license and notices.`,
    "Runtime npm dependencies retain their upstream licenses in app\\node_modules.",
    "VLC is not bundled. Install it from https://www.videolan.org/vlc/.",
    "Microsoft Dev Tunnel is not redistributed. Hosting setup downloads a hash-pinned official executable after the user chooses to set up hosting.",
    "Microsoft Dev Tunnel terms: https://aka.ms/devtunnels/tos",
    "This application is not affiliated with or endorsed by Google, Microsoft, or VideoLAN.",
    "", "Production dependencies:"
  ];
  for (const [relative, pkg] of Object.entries(lock.packages)) {
    if (!relative || pkg.dev || !relative.startsWith("node_modules/")) continue;
    if (relative.includes("..") || resolve(root, relative) === root) throw new Error("Unexpected dependency path.");
    const source = join(root, ...relative.split("/"));
    if (!(await exists(source))) {
      if (pkg.optional) continue;
      throw new Error(`Missing production dependency: ${relative}. Run npm ci.`);
    }
    await cp(source, join(app, ...relative.split("/")), {
      recursive: true, filter: path => !path.slice(source.length).split(/[\\/]/).includes("node_modules")
    });
    notices.push(`${relative.replace("node_modules/", "")} ${pkg.version} - ${pkg.license || "see package notices"}`);
    packageCount++;
  }
  await writeFile(join(payload, "THIRD-PARTY-NOTICES.txt"), notices.join("\r\n"));
  const files = [];
  async function inventory(folder, relative = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await inventory(join(folder, entry.name), name);
      else {
        if (entry.name === ".env" || /^client_secret.*\.json$/i.test(entry.name) || /ffmpeg.*\.exe$/i.test(entry.name)) throw new Error("A forbidden build input entered the payload.");
        files.push({ path: name, sha256: createHash("sha256").update(await readFile(join(folder, entry.name))).digest("hex") });
      }
    }
  }
  await inventory(payload);
  await writeFile(join(artifacts, "payload-manifest.json"), JSON.stringify({ version: manifest.version, node: process.version, packages: packageCount, files }, null, 2));
  run(compiler, ["/Qp", `/DAppVersion=${manifest.version}`, join(root, "packaging", "setup.iss")]);
  const setup = join(artifacts, `VLC-Drive-Watch-Party-Setup-${manifest.version}.exe`);
  const checksum = createHash("sha256").update(await readFile(setup)).digest("hex");
  await writeFile(`${setup}.sha256`, `${checksum}  ${setup.split("\\").pop()}\r\n`);
  console.log(`Installer created: ${setup}`);
  console.log(`Bundled ${packageCount} production packages. No user tokens, .env, VLC, Dev Tunnel executable, or FFmpeg.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
