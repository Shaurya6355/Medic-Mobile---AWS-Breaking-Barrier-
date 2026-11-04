import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import { artifactKey, inputPdfKey, NotFound } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { routes } from "../contract/routes.js";
import { CreateCommentRequest, CreateRunRequest, SaveVersionRequest } from "../contract/schemas.js";
import type { CreateRunResponse } from "../contract/schemas.js";
import type { Run } from "../domain/types.js";
import type { LogicModelValidator } from "../steps/logicModelValidator.js";
import { Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";

// Narrow view of the Orchestrator so the API depends on only what it calls.
export interface OrchestratorPort {
  createRun(pages: number[] | undefined, filename: string): Promise<Run>;
  resume(runId: string): Promise<void>;
}

export interface ServerDeps {
  orchestrator: OrchestratorPort;
  store: Store;
  artifacts: ArtifactStore;
  validator: LogicModelValidator;
  presign: (key: string) => Promise<string>;
  onVersionSaved: (runId: string, n: number) => Promise<void>;
  maxPages: number;
  now?: () => number;
  logger?: boolean;
}

const BODY_LIMIT = 5 * 1024 * 1024;

function parseBody<T>(schema: ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  void reply.code(400).send({ error: "invalid_request", issues });
  return undefined;
}

function parseVersionNumber(raw: string, reply: FastifyReply): number | undefined {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
  }
  void reply.code(400).send({ error: "invalid_request", issues: ["n: must be an integer"] });
  return undefined;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { orchestrator, store, artifacts, validator, presign, onVersionSaved, maxPages } = deps;
  const now = deps.now ?? Date.now;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: BODY_LIMIT });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof Conflict) {
      req.log.debug({ detail: err.message }, "conflict");
      return reply.code(409).send({ error: "conflict" });
    }
    if (err instanceof NotFound) return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      if (status === 413) return reply.code(413).send({ error: "payload_too_large" });
      if (status === 415) return reply.code(415).send({ error: "unsupported_media_type" });
      return reply.code(status).send({ error: "invalid_request", issues: [] });
    }
    req.log.error({ errName: err.name }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  app.post(routes.pattern.runs, async (req, reply) => {
    const body = parseBody(CreateRunRequest, req.body, reply);
    if (!body) return reply;
    const tooBig = (body.pages ?? []).filter((p) => p > maxPages);
    if (tooBig.length > 0) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: [`pages exceed maximum of ${maxPages}: ${tooBig.join(", ")}`],
      });
    }
    const run = await orchestrator.createRun(body.pages, body.filename);
    const uploadUrl = await presign(inputPdfKey(run.runId));
    const res: CreateRunResponse = { runId: run.runId, uploadUrl };
    return reply.code(201).send(res);
  });

  app.get(routes.pattern.runs, async () => {
    const runs = await store.listRuns();
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  });

  app.get<{ Params: { id: string } }>(routes.pattern.run, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    const steps = await store.listSteps(run.runId);
    const costs = steps.flatMap((s) => (s.costUsd === undefined ? [] : [s.costUsd]));
    const totals = {
      inputTokens: steps.reduce((a, s) => a + s.inputTokens, 0),
      outputTokens: steps.reduce((a, s) => a + s.outputTokens, 0),
      costUsd: costs.length === 0 ? null : costs.reduce((a, c) => a + c, 0),
      latencyMs: steps.reduce((a, s) => a + (s.latencyMs ?? 0), 0),
    };
    return { run, steps, totals };
  });

  app.get<{ Params: { id: string } }>(routes.pattern.versions, async (req, reply) => {
    if (!(await store.getRun(req.params.id))) return reply.code(404).send({ error: "not_found" });
    return store.listVersions(req.params.id);
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.version, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const version = await store.getVersion(req.params.id, n);
    if (!version) return reply.code(404).send({ error: "not_found" });
    const bytes = await artifacts.get(version.artifactKey);
    return { version, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  });

  app.post<{ Params: { id: string } }>(routes.pattern.versions, async (req, reply) => {
    const runId = req.params.id;
    if (!(await store.getRun(runId))) return reply.code(404).send({ error: "not_found" });
    const versions = await store.listVersions(runId);
    const latest = versions[versions.length - 1];
    if (!latest) return reply.code(409).send({ error: "no_base_version" });
    const req_ = parseBody(SaveVersionRequest, req.body, reply);
    if (!req_) return reply;
    if (req_.parentVersion !== latest.n) {
      req.log.debug({ parentVersion: req_.parentVersion, latest: latest.n }, "stale parentVersion");
      return reply.code(409).send({ error: "conflict" });
    }
    const result = validator.validate(req_.body);
    if (!result.ok) return reply.code(422).send({ error: "invalid_logic_model", issues: result.issues });

    const n = latest.n + 1;
    const key = artifactKey(runId, "versions", `v${n}-${randomUUID()}.json`);
    await artifacts.put(key, JSON.stringify(req_.body, null, 2), "application/json");
    await store.addVersion({
      runId,
      n,
      parent: latest.n,
      author: req_.author,
      createdAt: now(),
      artifactKey: key,
    });
    try {
      await onVersionSaved(runId, n);
    } catch (err) {
      req.log.error({ runId, n, errName: err instanceof Error ? err.name : "unknown" }, "onVersionSaved failed");
    }
    return reply.code(201).send({ n });
  });

  app.post<{ Params: { id: string; n: string } }>(routes.pattern.comments, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    if (!(await store.getVersion(req.params.id, n))) return reply.code(404).send({ error: "not_found" });
    const body = parseBody(CreateCommentRequest, req.body, reply);
    if (!body) return reply;
    const comment = {
      runId: req.params.id,
      n,
      itemRef: body.itemRef,
      author: body.author,
      text: body.text,
      createdAt: now(),
    };
    await store.addComment(comment);
    return reply.code(201).send(comment);
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.comments, async (req, reply) => {
    const n = parseVersionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    if (!(await store.getVersion(req.params.id, n))) return reply.code(404).send({ error: "not_found" });
    return store.listComments(req.params.id, n);
  });

  app.post<{ Params: { id: string } }>(routes.pattern.resume, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (run.state !== "failed") return reply.code(409).send({ error: "not_failed" });
    const runId = run.runId;
    orchestrator.resume(runId).catch((err: unknown) => {
      app.log.error({ runId, errName: err instanceof Error ? err.name : "unknown" }, "resume failed");
    });
    return reply.code(202).send({ runId });
  });

  return app;
}
