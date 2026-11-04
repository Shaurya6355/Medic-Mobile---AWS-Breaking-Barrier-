import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 8787);

/** Every setting comes from the environment so the same code runs locally and in the EC2 container. */
export const config = {
  port,
  /** Where local mode keeps the emulated bucket, queue and state. */
  dataDir: process.env.DATA_DIR ?? path.join(root, ".local-data"),
  bucket: process.env.BUCKET ?? "guidelines-local",
  region: process.env.AWS_REGION ?? "us-west-2",
  /** Base URL the browser uses to reach this server (for local presigned upload URLs). */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:5174").split(",").map(s => s.trim()),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  presignSeconds: 15 * 60,
  pollMs: Number(process.env.WORKER_POLL_MS ?? 500),
  visibilityTimeoutMs: 60_000,
  maxReceives: 3,
};
export type Config = typeof config;
