import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import { artifactKey } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { answerChat } from "../chat/chat.js";
import { routes } from "../contract/routes.js";
import { ActivityQuery, ChatRequest, PreviewEditsRequest, RestoreRequest, SaveEditsRequest } from "../contract/schemas.js";
import { describeAudit } from "../activity/describe.js";
import { describeFlowNodes } from "../edit/flowNodes.js";
import { previewEdits, simpleBehaviourDiff } from "../edit/preview.js";
import type { TreeEdit } from "../edit/treeEdits.js";
import { checkBudget, type Usage } from "../guard/budget.js";
import { RateLimiter } from "../guard/rateLimit.js";
import { loadVersion, previewFindings } from "../signoff/checks.js";
import type { Model } from "../logic/index.js";
import type { PriceTable } from "../metrics/cost.js";
import type { ModelClient } from "../model/modelClient.js";
import type { Signoff } from "../signoff/signoff.js";
import type { Store } from "../store/store.js";
import type { LogicModelValidator } from "../steps/logicModelValidator.js";
import { saveVersion } from "../versions/saveVersion.js";

export interface ClinicianDeps {
  store: Store;
  artifacts: ArtifactStore;
  signoff: Signoff;
  validator: LogicModelValidator;
  onVersionSaved: (runId: string, n: number) => Promise<void>;
  now: () => number;
  /** Absent: the chat route answers 503 chat_unavailable. */
  chat?: {
    model: ModelClient;
    modelId: string;
    prices: PriceTable;
    maxCostUsd: number;
    /** Per-run token cap used when the chat model has no price. Default 200000. */
    maxTokens?: number;
    ratePerMin: number;
  };
}

const DEFAULT_CHAT_MAX_TOKENS = 200000;
const KNOWN_OPS = ["setQuestionLabel", "setThreshold", "setOutcomeText", "setFollowUpDays"];
const MAX_DIFF_ENTRIES = 300;

function parse<T>(schema: ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  void reply.code(400).send({ error: "invalid_request", issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return undefined;
}

function versionNumber(raw: string, reply: FastifyReply): number | undefined {
  if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  void reply.code(400).send({ error: "invalid_request", issues: ["version: must be an integer"] });
  return undefined;
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Path -> value map of a JSON document (leaves only). */
function flatten(v: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(v)) {
    if (v.length === 0) out.set(path, []);
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  } else if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 0) out.set(path, {});
    for (const k of keys) flatten((v as Record<string, unknown>)[k], path === "" ? k : `${path}.${k}`, out);
  } else out.set(path, v);
}

export interface StructuralChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export function structuralDiff(a: unknown, b: unknown): { changes: StructuralChange[]; total: number; truncated: boolean } {
  const x = new Map<string, unknown>();
  const y = new Map<string, unknown>();
  flatten(a, "", x);
  flatten(b, "", y);
  const all: StructuralChange[] = [];
  for (const [p, v] of x) {
    if (!y.has(p)) all.push({ path: p, kind: "removed", before: v });
    else if (JSON.stringify(y.get(p)) !== JSON.stringify(v)) all.push({ path: p, kind: "changed", before: v, after: y.get(p) });
  }
  for (const [p, v] of y) if (!x.has(p)) all.push({ path: p, kind: "added", after: v });
  return { changes: all.slice(0, MAX_DIFF_ENTRIES), total: all.length, truncated: all.length > MAX_DIFF_ENTRIES };
}

export function registerClinicianRoutes(app: FastifyInstance, deps: ClinicianDeps): void {
  const { store, artifacts, signoff } = deps;
  const limiter = deps.chat ? new RateLimiter(deps.chat.ratePerMin, deps.chat.ratePerMin / 60, deps.now) : undefined;
  const runExists = async (id: string, reply: FastifyReply): Promise<boolean> => {
    if (await store.getRun(id)) return true;
    void reply.code(404).send({ error: "not_found" });
    return false;
  };
  // Loads a version's body as a model, or answers 404 (unknown version) / 422 (body is not a valid model).
  const loadModel = async (runId: string, n: number, reply: FastifyReply) => {
    const v = await store.getVersion(runId, n);
    if (!v) {
      void reply.code(404).send({ error: "not_found" });
      return undefined;
    }
    const loaded = await loadVersion({ store, artifacts }, runId, n);
    if (!loaded.model) {
      void reply.code(422).send({ error: "invalid_logic_model", issues: loaded.issues.slice(0, 10) });
      return undefined;
    }
    return { model: loaded.model as Model, sha: loaded.sha, raw: loaded.raw };
  };
  const latestN = async (runId: string): Promise<number> => (await store.listVersions(runId)).reduce((m, v) => Math.max(m, v.n), 0);
  // 422 unsupported_edit for any op outside the closed set, before the strict schema (which would say 400).
  const unsupported = (body: unknown): string | undefined => {
    const edits = typeof body === "object" && body !== null ? (body as { edits?: unknown }).edits : undefined;
    if (!Array.isArray(edits)) return undefined;
    for (const e of edits) {
      const op = typeof e === "object" && e !== null ? (e as { op?: unknown }).op : undefined;
      if (typeof op !== "string" || !KNOWN_OPS.includes(op)) return typeof op === "string" ? op.slice(0, 50) : "(missing)";
    }
    return undefined;
  };
  const sendSave = (reply: FastifyReply, r: Awaited<ReturnType<typeof saveVersion>>, extra: object = {}) => {
    if (r.ok) return reply.code(201).send({ n: r.n, checks_status: r.checks_status, ...extra });
    return reply.code(r.status).send({ error: r.error, ...(r.issues ? { issues: r.issues } : {}), ...(r.expected ? { expected: r.expected } : {}) });
  };
  const saveDeps = { store, artifacts, validator: deps.validator, onVersionSaved: deps.onVersionSaved, now: deps.now };
  const idemKey = (h: unknown): string | undefined => (typeof h === "string" && h.length > 0 && h.length <= 200 ? h : undefined);

  // Activity feed.
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(routes.pattern.activity, async (req, reply) => {
    const run = await store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    const q = parse(ActivityQuery, req.query, reply);
    if (!q) return reply;
    return describeAudit(await store.listAudit(run.runId), run.state, q.after === undefined ? {} : { after: q.after });
  });

  // Chat (answers only).
  app.post<{ Params: { id: string } }>(routes.pattern.chat, async (req, reply) => {
    const runId = req.params.id;
    if (!(await runExists(runId, reply))) return reply;
    const body = parse(ChatRequest, req.body, reply);
    if (!body) return reply;
    const chat = deps.chat;
    if (!chat || !limiter) return reply.code(503).send({ error: "chat_unavailable" });
    if (!limiter.tryTake(`${runId}:${body.userId}`)) return reply.code(429).send({ error: "rate_limited" });

    // Spend so far on this run's chat, from the audit pointers. No prices configured: no cost cap.
    const audit = await store.listAudit(runId);
    const past: Usage[] = audit.flatMap((e) => {
      const d = e.detail as { inputTokens?: unknown; outputTokens?: unknown; modelId?: unknown } | null;
      return e.type === "chat_turn" && d && typeof d.inputTokens === "number" && typeof d.outputTokens === "number" && typeof d.modelId === "string"
        ? [{ modelId: d.modelId, inputTokens: d.inputTokens, outputTokens: d.outputTokens }]
        : [];
    });
    // Fails closed: with no price for the chat model (PRICES_JSON empty) a per-run token cap applies instead.
    const maxTokens = chat.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS;
    const priced = Object.hasOwn(chat.prices, chat.modelId);
    if (priced) {
      if (!checkBudget(chat.prices, past, chat.maxCostUsd, maxTokens).ok) return reply.code(429).send({ error: "chat_budget_exceeded" });
    } else if (past.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0) >= maxTokens) {
      return reply.code(429).send({ error: "chat_budget_exceeded" });
    }

    const used = { inputTokens: 0, outputTokens: 0 };
    const metered: ModelClient = {
      generateJson: async (r) => {
        const out = await chat.model.generateJson(r);
        used.inputTokens += out.usage.inputTokens;
        used.outputTokens += out.usage.outputTokens;
        return out;
      },
    };
    const result = await answerChat(
      { store, artifacts, signoff, model: metered, modelId: chat.modelId, now: deps.now },
      { runId, userId: body.userId, messages: body.messages },
    );

    // Trace, never model memory: one jsonl line per turn plus an audit pointer (no text in the audit).
    const at = deps.now();
    const key = artifactKey(runId, "chat", `${new Date(at).toISOString().slice(0, 10)}.jsonl`);
    const question = [...body.messages].reverse().find((m) => m.from === "user")?.text ?? "";
    const line = JSON.stringify({ at, userId: body.userId, question, reply: result.reply, citations: result.citations, ...used, modelId: chat.modelId }) + "\n";
    try {
      let prev = "";
      try {
        prev = decode(await artifacts.get(key));
      } catch {
        prev = "";
      }
      await artifacts.put(key, prev + line, "application/x-ndjson");
      await store.appendAudit(runId, { at, type: "chat_turn", detail: { key, ...used, modelId: chat.modelId } });
    } catch (err) {
      req.log.error({ runId, errName: err instanceof Error ? err.name : "unknown" }, "chat log failed");
    }
    return result;
  });

  // The tree.
  app.get<{ Params: { id: string; n: string } }>(routes.pattern.flow, async (req, reply) => {
    if (!(await runExists(req.params.id, reply))) return reply;
    const n = versionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const m = await loadModel(req.params.id, n, reply);
    if (!m) return reply;
    return { ...describeFlowNodes(m.model), modelSha: m.sha };
  });

  app.post<{ Params: { id: string; n: string } }>(routes.pattern.editsPreview, async (req, reply) => {
    if (!(await runExists(req.params.id, reply))) return reply;
    const n = versionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const op = unsupported(req.body);
    if (op !== undefined) return reply.code(422).send({ error: "unsupported_edit", reason: `edit "${op}" is not supported` });
    const body = parse(PreviewEditsRequest, req.body, reply);
    if (!body) return reply;
    const m = await loadModel(req.params.id, n, reply);
    if (!m) return reply;
    const p = previewEdits(m.model, body.edits as TreeEdit[]);
    if (!p.ok) return reply.code(p.code === "unsupported_edit" ? 422 : 400).send({ error: p.code, reason: p.reason });
    // The findings the edited model would get as the next version (not saved).
    const record = await previewFindings(signoff.io, req.params.id, n, p.model, { author: body.userId, authorRole: "clinician" });
    const groups = (a: "program_officer" | "clinician") => record.views[a];
    return {
      flow: p.flow,
      nodes: p.nodes,
      paths: p.paths,
      behaviourChanges: p.behaviourChanges,
      findings: { status: record.status, blocking: record.blocking, gates: { canOfficerSign: record.gates.canOfficerSign, canClinicianSign: record.gates.canClinicianSign, canCompile: record.gates.canCompile, summary: record.gates.summary }, checksNotRun: record.checksNotRun, clinician: groups("clinician"), program_officer: groups("program_officer") },
    };
  });

  app.post<{ Params: { id: string; n: string } }>(routes.pattern.edits, async (req, reply) => {
    const runId = req.params.id;
    if (!(await runExists(runId, reply))) return reply;
    const n = versionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const op = unsupported(req.body);
    if (op !== undefined) return reply.code(422).send({ error: "unsupported_edit", reason: `edit "${op}" is not supported` });
    const body = parse(SaveEditsRequest, req.body, reply);
    if (!body) return reply;
    const m = await loadModel(runId, n, reply);
    if (!m) return reply;
    const latest = await latestN(runId);
    const key = idemKey(req.headers["idempotency-key"]);
    if (n !== latest || body.modelSha !== m.sha) {
      // A retry of a request that already saved gets the first result back; saveVersion looks the key up before
      // its own checks, and parentVersion -1 can never match, so a first-time stale request still ends in 409.
      if (key === undefined) return reply.code(409).send({ error: "conflict" });
      return sendSave(reply, await saveVersion(saveDeps, { runId, parentVersion: -1, body: m.raw, author: body.userId, authorRole: "clinician", origin: "tree_edit", idempotencyKey: key }));
    }
    const p = previewEdits(m.model, body.edits as TreeEdit[]);
    if (!p.ok) return reply.code(p.code === "unsupported_edit" ? 422 : 400).send({ error: p.code, reason: p.reason });
    const next = latest + 1;
    const edited = { ...p.model, meta: { ...p.model.meta, version: next, parent_version: latest, change_note: `Edited in the tree by ${body.userId}` } };
    const r = await saveVersion(saveDeps, {
      runId,
      parentVersion: latest,
      body: edited,
      author: body.userId,
      authorRole: "clinician",
      origin: "tree_edit",
      change: { ops: { kind: "tree_edit", edits: body.edits, paths: p.paths }, behaviourChanges: p.behaviourChanges },
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
    return sendSave(reply, r, r.ok ? { behaviourChanges: p.behaviourChanges } : {});
  });

  // History.
  app.get<{ Params: { id: string; a: string; b: string } }>(routes.pattern.diff, async (req, reply) => {
    if (!(await runExists(req.params.id, reply))) return reply;
    const a = versionNumber(req.params.a, reply);
    if (a === undefined) return reply;
    const b = versionNumber(req.params.b, reply);
    if (b === undefined) return reply;
    const ma = await loadModel(req.params.id, a, reply);
    if (!ma) return reply;
    const mb = await loadModel(req.params.id, b, reply);
    if (!mb) return reply;
    return { a, b, structural: structuralDiff(ma.raw, mb.raw), behaviourChanges: simpleBehaviourDiff(ma.model, mb.model) };
  });

  app.get<{ Params: { id: string; n: string } }>(routes.pattern.change, async (req, reply) => {
    if (!(await runExists(req.params.id, reply))) return reply;
    const n = versionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const v = await store.getVersion(req.params.id, n);
    if (!v) return reply.code(404).send({ error: "not_found" });
    const key = v.changeKey ?? artifactKey(req.params.id, "changes", `v${n}.json`);
    try {
      return JSON.parse(decode(await artifacts.get(key))) as unknown;
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  app.post<{ Params: { id: string; n: string } }>(routes.pattern.restore, async (req, reply) => {
    const runId = req.params.id;
    if (!(await runExists(runId, reply))) return reply;
    const n = versionNumber(req.params.n, reply);
    if (n === undefined) return reply;
    const body = parse(RestoreRequest, req.body, reply);
    if (!body) return reply;
    const m = await loadModel(runId, n, reply);
    if (!m) return reply;
    const latest = await latestN(runId);
    const copy = { ...m.model, meta: { ...m.model.meta, version: latest + 1, parent_version: latest, change_note: `Restored from version ${n} by ${body.userId}` } };
    const key = idemKey(req.headers["idempotency-key"]);
    const r = await saveVersion(saveDeps, {
      runId,
      parentVersion: latest,
      body: copy,
      author: body.userId,
      authorRole: "clinician",
      origin: "restore",
      change: { ops: { kind: "restore", restoredFrom: n } },
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    });
    return sendSave(reply, r, r.ok ? { restoredFrom: n } : {});
  });
}
