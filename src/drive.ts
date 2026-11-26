import { randomBytes, createHash } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { Media } from "./protocol.js";

export interface Drive {
  metadata(fileId: string): Promise<Media>;
  open(fileId: string, range: string | undefined, signal: AbortSignal): Promise<Response>;
}
export class GoogleDrive implements Drive {
  private readonly client: OAuth2Client;
  private pending?: { state: string; verifier: string; expires: number };
  public signedIn = false;
  public get configured(): boolean { return Boolean(this.config.clientId); }
  public constructor(private readonly config: { clientId: string; clientSecret?: string; redirect: string }) {
    this.client = new OAuth2Client(config.clientId, config.clientSecret, config.redirect);
  }
  public login(): string {
    if (!this.config.clientId) throw new Error("Configure a Google Desktop OAuth client in .env first.");
    const verifier = randomBytes(48).toString("base64url");
    this.pending = { state: randomBytes(32).toString("hex"), verifier, expires: Date.now() + 300000 };
    return this.client.generateAuthUrl({
      access_type: "offline", prompt: "consent",
      scope: ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"],
      state: this.pending.state, code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: createHash("sha256").update(verifier).digest("base64url")
    });
  }
  public async callback(state: string, code: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.expires < Date.now() || pending.state !== state) throw new Error("Google sign-in expired or state did not match. Start again.");
    this.pending = undefined;
    const result = await this.client.getToken({ code, codeVerifier: pending.verifier });
    this.client.setCredentials(result.tokens);
    this.signedIn = true;
  }
  public async token(): Promise<string> {
    if (!this.signedIn) throw new Error("Sign in to Google first.");
    const result = await this.client.getAccessToken();
    if (!result.token) throw new Error("Google access expired; sign in again.");
    return result.token;
  }
  public async metadata(fileId: string): Promise<Media> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", "id,name,size,mimeType,capabilities(canDownload)");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!response.ok) throw new Error("This account cannot read the file. Check sharing and select the original file in Google Picker.");
    const file = await response.json() as { id: string; name: string; size?: string; mimeType: string; capabilities?: { canDownload?: boolean } };
    if (!file.capabilities?.canDownload || !file.size) throw new Error("The file is not downloadable.");
    if (!file.mimeType.startsWith("video/") && !/\.(mkv|mp4|webm|avi|mov)$/i.test(file.name)) throw new Error("Select a video file.");
    return { fileId: file.id, name: file.name, size: Number(file.size), mimeType: file.mimeType };
  }
  public async open(fileId: string, range: string | undefined, signal: AbortSignal): Promise<Response> {
    const headers = new Headers({ Authorization: `Bearer ${await this.token()}` });
    if (range) headers.set("Range", range);
    return fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers, signal });
  }
}
