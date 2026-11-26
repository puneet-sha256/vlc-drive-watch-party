import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Pinned to the Microsoft.devtunnel WinGet manifest; never execute an unchecked download.
const downloadUrl = "https://tunnelsassetsprod.blob.core.windows.net/cli/1.0.2115+e16833f284/devtunnel.exe";
const expectedHash = "f11c797e90397a0a8e9bee711d500473632be27839deeb4fb3d0f5dbc6ffd2dc";
export async function prepareHostingTool(target: string, signal: AbortSignal): Promise<void> {
  try {
    if (createHash("sha256").update(await readFile(target)).digest("hex") === expectedHash) return;
  } catch {}
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.download`;
  try {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const response = await fetch(downloadUrl, { signal: timeout, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Download failed.");
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, next) {
        size += chunk.length;
        next(size > 64 * 1024 * 1024 ? new Error("Hosting tool exceeds the download limit.") : null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(temporary, { flags: "wx" }), { signal: timeout });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    if (hash.digest("hex") !== expectedHash) throw new Error("Checksum mismatch.");
    timeout.throwIfAborted();
    await rename(temporary, target);
  } catch {
    throw new Error("Hosting tool download did not complete or could not be verified. Check your connection and try again.");
  } finally { await unlink(temporary).catch(() => {}); }
}
