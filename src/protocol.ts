import { z } from "zod";

export const mediaSchema = z.object({
  fileId: z.string().min(1).max(256), name: z.string().min(1).max(255),
  size: z.number().positive().finite(), mimeType: z.string().min(1).max(100)
});
export type Media = z.infer<typeof mediaSchema>;
export const protocolVersion = 2;
export const syncInterval = 1000;
export const driftTolerance = 3;
export const resumeTolerance = 1;
export const progressLifetime = 5000;
export const maximumWait = 30000;
export interface Playback {
  playing: boolean; position: number; timestamp: number; revision: number;
  seekRevision: number; seekPosition: number;
}
export interface Snapshot {
  roomId: string; media: Media; playback: Playback; participants: number;
  protocolVersion: number; joinPosition: number; waiting: string[]; recovering: number;
}
export const commandSchema = z.object({
  action: z.enum(["play", "pause", "seek"]),
  position: z.number().min(0).max(86400).finite(),
  revision: z.number().int().nonnegative()
});
export const progressSchema = z.object({
  position: z.number().min(0).max(86400).finite(),
  revision: z.number().int().nonnegative()
});
export function expected(state: Playback, now = Date.now()): number {
  return state.position + (state.playing ? Math.max(0, now - state.timestamp) / 1000 : 0);
}
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Use a server origin without a path, credentials, or query.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Remote synchronization requires HTTPS.");
  }
  return url.origin;
}
export function parseInvite(value: string) {
  const url = new URL(value);
  const origin = serverOrigin(url.origin);
  const fragment = new URLSearchParams(url.hash.slice(1));
  return {
    origin,
    roomId: z.string().uuid().parse(fragment.get("room")),
    ticket: z.string().regex(/^[a-f0-9]{64}$/).parse(fragment.get("key"))
  };
}
