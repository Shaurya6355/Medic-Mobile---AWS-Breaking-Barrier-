import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { saveNewVersion } from "../api/saveVersion.js";
import { artifactKey, NotFound } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { StepUsage } from "../engine/step.js";
import { parseModel } from "../logic/index.js";
import type { Model } from "../logic/index.js";
import { cost } from "../metrics/cost.js";
import type { PriceTable } from "../metrics/cost.js";
import { ModelOutputError } from "../model/modelClient.js";
import type { ModelClient, ModelContent } from "../model/modelClient.js";
import { ExtractionOutput } from "../steps/extractionSchema.js";
import { parseModelValidator } from "../steps/logicModelValidator.js";
import type { LogicModelValidator } from "../steps/logicModelValidator.js";
import { Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";
import type { UsageRow } from "../metrics/usage.js";
import type { RevisionDispatcher } from "./dispatch.js";
import type { AppliedEdit, InstructionNote, Proposal, RefusedEdit, Revision, RevisionComment, RevisionRole, RevisionUsage } from "./types.js";
import { APPLYING_STALE_MS, revisionKey } from "./types.js";

/**
 * The pure engine the service drives (engine.ts implements it; the service never imports it, production
 * wires it in). Everything the model may say is checked inside the engine; the service only moves data,
 * calls the model twice (instruction, proposal) and saves the result through the same path as a hand edit.
 */
export interface RevisionEngine {
  /** Keeps only notes on commented items, at most one per comment (code decides, not the model). */
  filterNotes(notes: InstructionNote[], comments: RevisionComment[]): InstructionNote[];
  allowedTargets(model: Model, comments: RevisionComment[]): unknown;
  buildInstructionRequest(a: { model: Model; comments: RevisionComment[]; prompt: string }): {
    system: string;
    content: ModelContent[];
    schema: z.ZodType<{ instruction: string; notes: InstructionNote[] }>;
  };
  buildProposalRequest(a: {
    model: Model;
    extraction: ExtractionOutput;
    comments: RevisionComment[];
    instruction: string;
    fillPrompt: string;
    revisePrompt: string;
    targets: unknown;
  }): { system: string; content: ModelContent[]; schema: z.ZodType<Proposal> };
  applyProposal(a: {
    model: Model;
    extraction: ExtractionOutput;
    proposal: Proposal;
    targets: unknown;
    revision: { id: string; fromVersion: number; nowIso: string; instruction: string };
    comments: RevisionComment[];
  }): { model: Model | undefined; applied: AppliedEdit[]; refused: RefusedEdit[]; questionsAdded: string[] };
}

/** An expected failure with the HTTP status and code the API answers with. `detail` fields are added to the body. */
export class RevisionError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RevisionError";
  }
}

export interface RevisionLogger {
  warn(detail: object, msg: string): void;
  error(detail: object, msg: string): void;
}

export interface RevisionServiceDeps {
  store: Store;
  artifacts: ArtifactStore;
  model: ModelClient;
  engine: RevisionEngine;
  modelId: string;
  /** Prompt texts, loaded by the caller: the original fill prompt, the step 1 prompt, the step 2 addendum. */
  prompts: { fill: string; instruction: string; revise: string };
  /** Starts step 2 outside the HTTP request (see dispatch.ts). */
  dispatcher: RevisionDispatcher;
  now?: () => number;
  /** Runs the checks on a saved version (Signoff.onVersionSaved), exactly as after a hand edit. */
  onVersionSaved: (runId: string, n: number) => Promise<void>;
  loadExtraction?: (runId: string) => Promise<ExtractionOutput>;
  /** Same validator the API uses for saved versions. Default: parseModelValidator. */
  validator?: LogicModelValidator;
  prices?: PriceTable;
  maxTokens?: number;
  /** How long step 2 holds the run lease while the model works. Default DEFAULT_REVISION_LEASE_MS (12 minutes). */
  leaseMs?: number;
  /** When the run lease is busy, runApply tries again this many times, waiting leaseRetryMs between tries. */
  leaseRetries?: number;
  leaseRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Server-side detail only (error text never goes into a response or a revision). Default: silent. */
  logger?: RevisionLogger;
}

export interface Actor {
  role: RevisionRole;
  userId: string;
}

const SAFE_ID = /^[A-Za-z0-9-]+$/;
export const STALE_ERROR = "The background step did not finish; confirm again.";
const STATUSES = new Set(["instruction_ready", "applying", "applied", "no_change", "failed"]);

const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Listing without a store listing: ArtifactStore cannot list a prefix, so the index is the audit trail.
 * Creating a revision appends an audit event "revision_requested" {revisionId, n}; listRevisions reads the
 * run's audit events and loads each revision artifact. An audit append is one atomic write, so two
 * simultaneous requests cannot lose each other's entry (a read-modify-write index.json could). A revision
 * artifact is written before its audit event; an artifact without an event is invisible and harmless.
 * Every paid model call also appends "revision_usage" {revisionId, fromVersion, tokens, cost...}, so the run
 * totals (GET /runs/:id) come from the audit trail alone, without loading any revision artifact.
 */
/**
 * Run lease held while step 2 works. It must outlast the slowest model call (DEFAULT_BEDROCK_TIMEOUT_MS = 6 min,
 * src/model/strands.ts) plus applying, saving and the checks, and stay below the Lambda timeout (15 min), because
 * the lease is not renewed: a shorter one lets a second worker take over a live one.
 */
export const DEFAULT_REVISION_LEASE_MS = 12 * 60 * 1000;

export class RevisionService {
  private readonly now: () => number;
  private readonly loadExtraction: (runId: string) => Promise<ExtractionOutput>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: RevisionServiceDeps) {
    this.now = d.now ?? Date.now;
    this.loadExtraction = d.loadExtraction ?? ((runId) => defaultLoadExtraction(d.artifacts, runId));
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private warn(detail: object, msg: string): void {
    this.d.logger?.warn(detail, msg);
  }

  // ---------- step 1 (synchronous: one small model call) ----------

  async requestRevision(runId: string, n: number, input: Actor & { itemRefs?: string[] }): Promise<Revision> {
    const { store } = this.d;
    if (!(await store.getRun(runId))) throw new RevisionError(404, "not_found", `Run ${runId} not found`);
    const versions = await store.listVersions(runId);
    const version = versions.find((v) => v.n === n);
    if (!version) throw new RevisionError(404, "not_found", `Version ${n} not found`);
    const latest = versions[versions.length - 1];
    if (!latest || latest.n !== n) throw new RevisionError(409, "not_latest", `Version ${n} is not the latest (${latest?.n}); only the latest can be revised`);
    if (version.status === "locked") throw new RevisionError(409, "locked", `Version ${n} is locked and cannot be revised`);

    let comments: RevisionComment[] = (await store.listComments(runId, n)).map((c) => ({
      itemRef: c.itemRef,
      text: c.text,
      author: c.author,
      source: "comment" as const,
      createdAt: c.createdAt,
    }));
    if (version.rejection) {
      const r = version.rejection;
      comments.push({ itemRef: r.itemRef ?? "version", text: r.comment, author: r.userId, source: "rejection", createdAt: r.rejectedAt });
    }
    if (input.itemRefs !== undefined) {
      const wanted = new Set(input.itemRefs);
      comments = comments.filter((c) => wanted.has(c.itemRef));
    }
    if (comments.length === 0) throw new RevisionError(422, "no_comments", `Version ${n} has no comments to revise from`);

    const model = await this.loadModel(version.artifactKey);
    const req = this.d.engine.buildInstructionRequest({ model, comments, prompt: this.d.prompts.instruction });
    const started = this.now();
    const base = {
      id: randomUUID(),
      runId,
      fromVersion: n,
      requestedBy: { userId: input.userId, role: input.role },
      comments,
      applied: [] as AppliedEdit[],
      refused: [] as RefusedEdit[],
      questionsAdded: [] as string[],
    };
    let call;
    try {
      call = await this.d.model.generateJson({ modelId: this.d.modelId, system: req.system, content: req.content, schema: req.schema, maxTokens: this.d.maxTokens ?? 4000 });
    } catch (e) {
      // The call may have been paid for and the person must see that it was tried: keep a failed revision.
      this.d.logger?.error({ runId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision step 1 model call failed");
      const at = this.now();
      const paid = e instanceof ModelOutputError && e.usage ? [this.usageEntry(e.usage, at - started)] : [];
      const invalid = e instanceof ModelOutputError;
      const failed: Revision = {
        ...base,
        instruction: "",
        notes: [],
        status: "failed",
        error: invalid ? `The AI did not return a usable instruction (${errName(e)}); try again.` : `The AI service did not answer (${errName(e)}); try again.`,
        usage: paid,
        createdAt: at,
        updatedAt: at,
      };
      await this.save(failed);
      await this.auditRequested(failed, input);
      for (const u of paid) await this.recordUsage(failed, u);
      throw invalid
        ? new RevisionError(502, "model_output_invalid", "The AI did not return a usable instruction; try again", { revisionId: failed.id })
        : new RevisionError(502, "model_unavailable", "The AI service did not answer; try again", { revisionId: failed.id });
    }
    const at = this.now();
    const revision: Revision = {
      ...base,
      instruction: call.value.instruction,
      notes: this.d.engine.filterNotes(call.value.notes, comments),
      status: "instruction_ready",
      usage: [this.usageEntry(call.usage, at - started)],
      createdAt: at,
      updatedAt: at,
    };
    await this.save(revision);
    await this.auditRequested(revision, input);
    await this.recordUsage(revision, revision.usage[0] as RevisionUsage);
    return revision;
  }

  // Counts and ids only: comment text never goes into the audit trail.
  private async auditRequested(rev: Revision, input: Actor): Promise<void> {
    await this.d.store.appendAudit(rev.runId, {
      at: rev.createdAt,
      type: "revision_requested",
      detail: { revisionId: rev.id, n: rev.fromVersion, userId: input.userId, role: input.role, comments: rev.comments.length },
    });
  }

  // ---------- step 2, part 1: confirm (fast; returns while the work runs in the background) ----------

  async confirmRevision(runId: string, revisionId: string, input: Actor & { instruction?: string }): Promise<Revision> {
    const { store } = this.d;
    await this.getRevision(runId, revisionId); // 404 early, before taking the lease

    // The lease is held only for the state change: two confirms of one revision cannot both pass, because the
    // status is re-read under the lease and the loser sees "applying".
    const owner = `revision-${randomUUID()}`;
    const held = await store.acquireLease(runId, owner, this.d.leaseMs ?? DEFAULT_REVISION_LEASE_MS, this.now());
    if (!held) throw new RevisionError(409, "busy", "The run is busy with another change; try again shortly");
    let applying: Revision;
    try {
      applying = await this.markApplying(runId, revisionId, input);
    } finally {
      await store.releaseLease(runId, owner);
    }

    try {
      await this.d.dispatcher.dispatch({ runId, revisionId });
    } catch (e) {
      this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision dispatch failed");
      const failed: Revision = { ...applying, status: "failed", error: `The background step could not be started (${errName(e)}); confirm again.`, updatedAt: this.now() };
      delete failed.applyingSince;
      await this.save(failed);
      await store.appendAudit(runId, { at: failed.updatedAt, type: "revision_failed", detail: { revisionId, n: applying.fromVersion, userId: input.userId, reason: "dispatch_failed" } });
      throw new RevisionError(502, "dispatch_failed", "The revision could not be started; confirm again", { revisionId });
    }
    return applying;
  }

  private async markApplying(runId: string, revisionId: string, input: Actor & { instruction?: string }): Promise<Revision> {
    const { store } = this.d;
    const raw = await this.readRevision(runId, revisionId);
    if (!raw) throw new RevisionError(404, "not_found", "Revision not found");
    const rev = this.withStale(raw); // a stale "applying" counts as failed
    if (rev.status !== "instruction_ready" && rev.status !== "failed") {
      throw new RevisionError(409, rev.status === "applying" ? "already_applying" : "already_final", `Revision is ${rev.status}; it cannot be confirmed again`);
    }
    const versions = await store.listVersions(runId);
    const latest = versions[versions.length - 1];
    if (!latest || latest.n !== rev.fromVersion) {
      throw new RevisionError(409, "superseded", `Version ${rev.fromVersion} is no longer the latest; request a new revision`);
    }
    if (latest.status === "locked") throw new RevisionError(409, "locked", `Version ${latest.n} is locked and cannot be revised`);
    const instruction = input.instruction ?? rev.instruction;
    if (instruction.trim().length === 0) throw new RevisionError(422, "no_instruction", "This revision has no instruction; send one in the confirm request or request a new revision");

    const at = this.now();
    const applying: Revision = {
      ...rev,
      status: "applying",
      confirmedInstruction: instruction,
      confirmedBy: { userId: input.userId, role: input.role },
      applyingSince: at,
      updatedAt: at,
    };
    delete applying.error;
    await this.save(applying);
    await store.appendAudit(runId, { at, type: "revision_confirmed", detail: { revisionId, n: rev.fromVersion, userId: input.userId, role: input.role, edited: input.instruction !== undefined } });
    return applying;
  }

  // ---------- step 2, part 2: the work (background; idempotent) ----------

  /**
   * Does the model call and applies the result. Safe to call twice (a Lambda async retry, a duplicate job): it
   * does nothing unless the revision is "applying", and the run lease serialises concurrent calls. Never
   * throws for an expected or unexpected failure: it writes status "failed" instead.
   */
  async runApply(runId: string, revisionId: string): Promise<void> {
    const { store } = this.d;
    try {
      const owner = `revision-${randomUUID()}`;
      const tries = Math.max(1, this.d.leaseRetries ?? 5);
      let held = false;
      for (let i = 0; i < tries && !held; i++) {
        const cur = await this.readRevision(runId, revisionId);
        if (!cur || cur.status !== "applying") return; // done by someone else, or nothing to do
        held = await store.acquireLease(runId, owner, this.d.leaseMs ?? DEFAULT_REVISION_LEASE_MS, this.now());
        if (!held && i + 1 < tries) await this.sleep(this.d.leaseRetryMs ?? 2000);
      }
      if (!held) {
        // Another worker may be running this very revision: write nothing. A dead one is reported by the stale rule.
        this.warn({ runId, revisionId }, "revision runApply: run lease busy; left as applying");
        return;
      }
      let result: { revision: Revision; savedN?: number } | undefined;
      try {
        result = await this.applyLocked(runId, revisionId);
      } finally {
        await store.releaseLease(runId, owner);
      }
      if (result?.savedN === undefined) return;
      // After the lease is released: the checks take the lease themselves (as after a hand edit).
      try {
        await this.d.onVersionSaved(runId, result.savedN);
      } catch (e) {
        this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision: checks after save failed");
        await this.save({
          ...result.revision,
          error: `The version was saved but its checks did not finish (${errName(e)}). They run again when the version is opened; if the run shows failed, resume it.`,
          updatedAt: this.now(),
        });
      }
    } catch (e) {
      this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision runApply failed unexpectedly");
      await this.failUnexpected(runId, revisionId, e);
    }
  }

  private async failUnexpected(runId: string, revisionId: string, e: unknown): Promise<void> {
    try {
      const cur = await this.readRevision(runId, revisionId);
      if (!cur || cur.status !== "applying") return;
      await this.save({ ...cur, status: "failed", error: `The revision step failed unexpectedly (${errName(e)}); confirm again.`, updatedAt: this.now() });
      await this.d.store.appendAudit(runId, { at: this.now(), type: "revision_failed", detail: { revisionId, n: cur.fromVersion, reason: "unexpected" } });
    } catch {
      // The stale rule reports it on read.
    }
  }

  private async applyLocked(runId: string, revisionId: string): Promise<{ revision: Revision; savedN?: number } | undefined> {
    const { store, engine } = this.d;
    const rev = await this.readRevision(runId, revisionId);
    if (!rev || rev.status !== "applying") return undefined; // double run: the first one finished
    const instruction = rev.confirmedInstruction ?? rev.instruction;
    const base: Revision = rev;
    const by = rev.confirmedBy?.userId ?? "unknown";
    const failWith = async (error: string, extraUsage: RevisionUsage[] = []): Promise<{ revision: Revision }> => {
      const failed: Revision = { ...base, status: "failed", error, usage: [...rev.usage, ...extraUsage], updatedAt: this.now() };
      delete failed.applyingSince;
      await this.save(failed);
      await store.appendAudit(runId, { at: failed.updatedAt, type: "revision_failed", detail: { revisionId, n: rev.fromVersion, userId: by } });
      return { revision: failed };
    };

    const versions = await store.listVersions(runId);
    const latest = versions[versions.length - 1];
    if (!latest || latest.n !== rev.fromVersion) return failWith(`Version ${rev.fromVersion} is no longer the latest; request a new revision.`);
    if (latest.status === "locked") return failWith(`Version ${latest.n} is locked and cannot be revised.`);

    let model: Model;
    let extraction: ExtractionOutput;
    let targets: unknown;
    let req: ReturnType<RevisionEngine["buildProposalRequest"]>;
    try {
      model = await this.loadModel(latest.artifactKey);
      extraction = await this.loadExtraction(runId);
      targets = engine.allowedTargets(model, rev.comments);
      req = engine.buildProposalRequest({
        model,
        extraction,
        comments: rev.comments,
        instruction,
        fillPrompt: this.d.prompts.fill,
        revisePrompt: this.d.prompts.revise,
        targets,
      });
    } catch (e) {
      this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision: preparing the request failed");
      return failWith(`The model or the extraction could not be prepared (${errName(e)}).`);
    }
    const started = this.now();
    let proposal: Proposal;
    let usage: RevisionUsage;
    try {
      const call = await this.d.model.generateJson({ modelId: this.d.modelId, system: req.system, content: req.content, schema: req.schema, maxTokens: this.d.maxTokens ?? 8000 });
      proposal = call.value;
      usage = this.usageEntry(call.usage, this.now() - started);
    } catch (e) {
      this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision step 2 model call failed");
      const paid = e instanceof ModelOutputError && e.usage ? [this.usageEntry(e.usage, this.now() - started)] : [];
      for (const u of paid) await this.recordUsage(rev, u);
      return failWith(
        e instanceof ModelOutputError ? `The AI did not return usable edits (${errName(e)}); confirm again.` : `The AI service did not answer (${errName(e)}); confirm again.`,
        paid,
      );
    }
    await this.recordUsage(rev, usage); // paid for: counted whatever happens next

    let result: ReturnType<RevisionEngine["applyProposal"]>;
    try {
      result = engine.applyProposal({
        model,
        extraction,
        proposal,
        targets,
        revision: { id: rev.id, fromVersion: rev.fromVersion, nowIso: new Date(this.now()).toISOString(), instruction },
        comments: rev.comments,
      });
    } catch (e) {
      this.d.logger?.error({ runId, revisionId, errName: errName(e), detail: errText(e).slice(0, 500) }, "revision: applying the proposal failed");
      return failWith(`The edits could not be applied (${errName(e)}).`, [usage]);
    }

    const done: Revision = {
      ...base,
      proposal,
      applied: result.applied,
      refused: result.refused,
      questionsAdded: result.questionsAdded,
      usage: [...rev.usage, usage],
      updatedAt: this.now(),
    };
    delete done.error;
    delete done.applyingSince;
    if (result.model === undefined) {
      const noChange: Revision = { ...done, status: "no_change" };
      await this.save(noChange);
      await store.appendAudit(runId, { at: noChange.updatedAt, type: "revision_no_change", detail: { revisionId, n: rev.fromVersion, userId: by, refused: result.refused.length, questions: result.questionsAdded.length } });
      return { revision: noChange };
    }

    // Defensive: whatever the engine returns must pass what a hand edit passes, and be the next link in the chain.
    const checked = (this.d.validator ?? parseModelValidator).validate(result.model);
    const meta = (result.model as { meta?: { version?: unknown; parent_version?: unknown } }).meta;
    const bad = !checked.ok
      ? `The revised model is not a valid logic model: ${checked.issues.slice(0, 5).join("; ")}`
      : meta?.version !== latest.n + 1 || meta?.parent_version !== latest.n
        ? `The revised model has meta.version ${String(meta?.version)} and parent_version ${String(meta?.parent_version)}; expected ${latest.n + 1} and ${latest.n}`
        : undefined;
    if (bad !== undefined) return failWith(bad, [usage]);

    const n = latest.n + 1;
    try {
      await saveNewVersion({ store, artifacts: this.d.artifacts, now: this.now }, { runId, n, parent: latest.n, author: "ai", body: result.model });
    } catch (e) {
      if (e instanceof Conflict) return failWith("Another version was saved at the same time; request a new revision.", [usage]);
      throw e; // unexpected: runApply writes a generic failure; the usage was recorded above
    }
    const applied: Revision = { ...done, status: "applied", toVersion: n };
    await this.save(applied);
    await store.appendAudit(runId, {
      at: applied.updatedAt,
      type: "revision_applied",
      detail: { revisionId, fromVersion: rev.fromVersion, toVersion: n, userId: by, role: rev.confirmedBy?.role, applied: result.applied.length, refused: result.refused.length, questions: result.questionsAdded.length },
    });
    return { revision: applied, savedN: n };
  }

  // ---------- reads ----------

  /** A stored revision, or undefined when the artifact is missing or unusable (logged without its content). */
  private async readRevision(runId: string, id: string): Promise<Revision | undefined> {
    if (!SAFE_ID.test(id)) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = await this.d.artifacts.get(revisionKey(runId, id));
    } catch (e) {
      if (e instanceof NotFound) return undefined;
      throw e;
    }
    let v: unknown;
    try {
      v = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      this.warn({ runId, revisionId: id }, "revision artifact is not valid JSON; skipped");
      return undefined;
    }
    const r = v as Partial<Revision> | null;
    if (
      typeof r !== "object" || r === null || r.id !== id || r.runId !== runId || typeof r.status !== "string" || !STATUSES.has(r.status) ||
      typeof r.fromVersion !== "number" || typeof r.instruction !== "string" || !Array.isArray(r.usage) || !Array.isArray(r.comments) ||
      typeof r.createdAt !== "number"
    ) {
      this.warn({ runId, revisionId: id }, "revision artifact has an unexpected shape; skipped");
      return undefined;
    }
    return v as Revision;
  }

  /** An "applying" revision whose worker is gone is reported as failed so the person can confirm again. */
  private withStale(rev: Revision): Revision {
    if (rev.status !== "applying") return rev;
    const since = rev.applyingSince ?? rev.updatedAt;
    if (this.now() - since <= APPLYING_STALE_MS) return rev;
    const out: Revision = { ...rev, status: "failed", error: STALE_ERROR };
    delete out.applyingSince;
    return out;
  }

  async getRevision(runId: string, id: string): Promise<Revision> {
    const rev = await this.readRevision(runId, id);
    if (!rev) throw new RevisionError(404, "not_found", "Revision not found");
    return this.withStale(rev);
  }

  async listRevisions(runId: string, n?: number): Promise<Revision[]> {
    const { store } = this.d;
    if (!(await store.getRun(runId))) throw new RevisionError(404, "not_found", `Run ${runId} not found`);
    const ids: string[] = [];
    for (const ev of await store.listAudit(runId)) {
      if (ev.type !== "revision_requested") continue;
      const d = ev.detail as { revisionId?: unknown; n?: unknown };
      if (typeof d.revisionId === "string" && typeof d.n === "number" && (n === undefined || d.n === n)) ids.push(d.revisionId);
    }
    const out: Revision[] = [];
    for (const id of ids) {
      const rev = await this.readRevision(runId, id); // a missing or corrupt one is skipped
      if (rev) out.push(this.withStale(rev));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Revision model calls of a run for the cost totals, from the audit trail only (no artifact is loaded). */
  async usageRows(runId: string): Promise<UsageRow[]> {
    const rows: UsageRow[] = [];
    for (const ev of await this.d.store.listAudit(runId)) {
      if (ev.type !== "revision_usage") continue;
      const d = ev.detail as Partial<Record<string, unknown>>;
      if (typeof d.inputTokens !== "number" || typeof d.outputTokens !== "number") continue;
      rows.push({
        process: "revision",
        ...(typeof d.fromVersion === "number" ? { versionId: String(d.fromVersion) } : {}),
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        ...(typeof d.costUsd === "number" ? { costUsd: d.costUsd } : {}),
        ...(typeof d.modelId === "string" ? { modelId: d.modelId } : {}),
        latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : 0,
      });
    }
    return rows;
  }

  // ---------- helpers ----------

  private async recordUsage(rev: Revision, u: RevisionUsage): Promise<void> {
    await this.d.store.appendAudit(rev.runId, { at: this.now(), type: "revision_usage", detail: { revisionId: rev.id, fromVersion: rev.fromVersion, ...u } });
  }

  private async save(rev: Revision): Promise<void> {
    await this.d.artifacts.put(revisionKey(rev.runId, rev.id), JSON.stringify(rev, null, 2), "application/json");
  }

  private async loadModel(key: string): Promise<Model> {
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(await this.d.artifacts.get(key)));
    } catch (e) {
      if (e instanceof SyntaxError) throw new RevisionError(422, "invalid_logic_model", "The version body is not valid JSON");
      throw e;
    }
    const p = parseModel(raw);
    if (!p.ok) throw new RevisionError(422, "invalid_logic_model", `The version is not a valid logic model: ${p.issues.slice(0, 5).join("; ")}`);
    return p.value;
  }

  private usageEntry(u: StepUsage, latencyMs: number): RevisionUsage {
    const c = cost(this.d.prices ?? {}, u.modelId, u.inputTokens, u.outputTokens);
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      ...(c !== undefined ? { costUsd: c } : {}),
      modelId: u.modelId,
      latencyMs,
    };
  }
}

async function defaultLoadExtraction(artifacts: ArtifactStore, runId: string): Promise<ExtractionOutput> {
  const key = artifactKey(runId, "extract", "extraction_output.json");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await artifacts.get(key)));
  } catch (e) {
    if (e instanceof NotFound) throw new Error(`Extraction output not found at ${key}`);
    if (e instanceof SyntaxError) throw new Error(`Extraction output at ${key} is not valid JSON`);
    throw e;
  }
  const parsed = ExtractionOutput.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Extraction output at ${key} does not match the extraction schema: ${parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
