import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { config as defaults, type Config } from "./config.ts";
import { LocalObjectStore, assertKey } from "./storage/objectStore.ts";
import { LocalQueue } from "./queue/queue.ts";
import { GuidelineStore, newSteps, typeOf, type GuidelineRecord } from "./state/guidelines.ts";
import { placeholderBuilder, type LogicModelBuilder } from "./pipeline/logicModel.ts";
import { startWorker } from "./worker.ts";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const UploadRequest = z.object({
  fileName: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  contentType: z.string().max(200).optional(),
});

/** Keeps the original name readable but safe as an S3 key segment. */
const safeName = (n: string) => n.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 120) || "file";

function kb(n: number) { return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

/** The record as the frontend's Guideline type expects it. */
function toApi(r: GuidelineRecord, s3uri: (k: string) => string) {
  const bits = [kb(r.size)];
  if (r.pages) bits.push(r.pages + (r.pages === 1 ? " page" : " pages"));
  if (r.blocks !== undefined) bits.push(r.blocks + " blocks");
  if (r.status === "Indexed" && r.logicModel) bits.push(r.logicModel.source === "placeholder" ? "placeholder logic model" : "logic model ready");
  if (r.status === "Unsupported") bits.push("this file type can't be read locally");
  return {
    id: r.id, name: r.name, type: r.type, status: r.status, pages: r.pages, meta: bits.join(" · "),
    steps: r.steps, error: r.error, s3Uri: s3uri(r.keys.upload), logicModel: r.logicModel,
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, `File is larger than ${kb(limit)}`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  try { return JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Body is not valid JSON"); }
}

export async function createApp(cfg: Config = defaults, builder: LogicModelBuilder = placeholderBuilder) {
  const log = (m: string) => console.log(new Date().toISOString(), m);
  const guidelines = await GuidelineStore.open(path.join(cfg.dataDir, "state"));
  const queue = new LocalQueue(path.join(cfg.dataDir, "queue"), cfg.visibilityTimeoutMs);
  const store = new LocalObjectStore(cfg.bucket, path.join(cfg.dataDir, "bucket", cfg.bucket), {
    publicUrl: cfg.publicUrl, region: cfg.region, notifyPrefixes: ["uploads/"],
    // Bucket notification: ObjectCreated under uploads/ goes to the queue.
    onObjectCreated: e => queue.send(JSON.stringify(e)),
  });
  const stopWorker = startWorker({ queue, store, guidelines, builder, pollMs: cfg.pollMs, maxReceives: cfg.maxReceives, log });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const find = (id: string) => { const g = guidelines.get(id); if (!g) throw new HttpError(404, "Guideline not found"); return g; };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const parts = url.pathname.split("/").filter(Boolean);
    const m = req.method ?? "GET";

    if (m === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, mode: "local", bucket: cfg.bucket, builder: builder.name });

    // Step 1: the browser asks for a presigned upload URL.
    if (m === "POST" && url.pathname === "/guidelines/upload-url") {
      const p = UploadRequest.safeParse(await readJson(req));
      if (!p.success) throw new HttpError(400, "Expected {fileName, size, contentType?}");
      if (p.data.size > cfg.maxUploadBytes) throw new HttpError(413, `File is larger than ${kb(cfg.maxUploadBytes)}`);
      const id = randomUUID();
      const key = `uploads/${id}/${safeName(p.data.fileName)}`;
      const rec: GuidelineRecord = {
        id, name: p.data.fileName, type: typeOf(p.data.fileName), size: p.data.size, createdAt: new Date().toISOString(),
        status: "Uploading", pages: null, steps: newSteps(), keys: { upload: key },
      };
      rec.steps[0].state = "running";
      rec.steps[0].startedAt = rec.createdAt;
      await guidelines.put(rec);
      return json(res, 201, {
        guideline: toApi(rec, k => store.uri(k)), key,
        upload: { method: "PUT", url: store.presignPut(key, cfg.presignSeconds), headers: { "Content-Type": p.data.contentType || "application/octet-stream" } },
      });
    }

    // Step 2: the browser PUTs the file to the (local) bucket with the presigned URL. S3 does this on AWS.
    if (m === "PUT" && parts[0] === "local-s3" && parts[1] === cfg.bucket) {
      const key = decodeURIComponent(parts.slice(2).join("/"));
      assertKey(key);
      if (!store.verifyPut(key, url.searchParams.get("X-Expires"), url.searchParams.get("X-Signature"))) throw new HttpError(403, "Upload URL is invalid or expired");
      const body = await readBody(req, cfg.maxUploadBytes);
      await store.put(key, body); // fires the ObjectCreated event
      res.writeHead(200, { ETag: `"${body.length}"` });
      return res.end();
    }

    if (m === "GET" && parts[0] === "guidelines") {
      if (parts.length === 1) return json(res, 200, guidelines.list().map(r => toApi(r, k => store.uri(k))));
      const g = find(parts[1]);
      if (parts.length === 2) return json(res, 200, toApi(g, k => store.uri(k)));
      const artifact = { "logic-model": g.keys.logicModel, digest: g.keys.digested, extracted: g.keys.extracted }[parts[2]];
      if (parts.length === 3 && parts[2] in { "logic-model": 1, digest: 1, extracted: 1 }) {
        if (!artifact) throw new HttpError(409, `Not ready: guideline is ${g.status}${g.error ? " (" + g.error + ")" : ""}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(await store.get(artifact));
      }
    }
    throw new HttpError(404, "Not found");
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = cfg.corsOrigins === "localhost" ? /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? "") : cfg.corsOrigins.includes(origin ?? "");
    if (origin && allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Expose-Headers", "ETag");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    route(req, res).catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error ${req.method} ${req.url}: ${e instanceof Error ? e.stack : e}`);
      if (!res.headersSent) json(res, status, { error: status === 500 ? "Internal error" : (e as Error).message });
      else res.end();
    });
  });

  return {
    server,
    listen: (port = cfg.port) => new Promise<number>(r => server.listen(port, () => r((server.address() as { port: number }).port))),
    stop: async () => { await stopWorker(); await new Promise(r => server.close(r)); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const app = await createApp();
  const port = await app.listen();
  console.log(`Guideline pipeline (local mode) on http://localhost:${port}`);
  console.log(`Bucket: ${defaults.bucket} -> ${path.join(defaults.dataDir, "bucket")}; logic model builder: ${placeholderBuilder.name}`);
  const shutdown = () => { void app.stop().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
