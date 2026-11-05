// Decorators that log and measure every step, audit event, version, signature and model call, without
// changing any call site. The data is ALSO stored where it already was (DynamoDB step and audit tables,
// S3); this adds the live view in CloudWatch Logs and Metrics.
import type { StepRecord } from "../domain/types.js";
import { ModelOutputError, type ModelClient } from "../model/modelClient.js";
import { AlreadyExists, Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";
import { cleanFields, type Fields, type Logger } from "./logger.js";

const errName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");
const errMsg = (e: unknown): string => (e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300));

function stepFields(r: Partial<StepRecord> & { runId?: string; step?: string; attempt?: number }): Fields {
  return {
    runId: r.runId,
    step: r.step,
    versionId: r.versionId,
    attempt: r.attempt,
    status: r.status,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    modelId: r.modelId,
    modelCalls: r.calls?.length,
    error: r.error,
  };
}

/**
 * Wraps a Store. Every state change is logged; step results and run outcomes also become CloudWatch metrics:
 * StepDurationMs/StepFailed (dimension Step), StepCostUsd, RunState (dimension State), Version/Signature counts,
 * AuditEvents (dimension Type). Reads and lease calls pass through untouched. Errors are rethrown unchanged.
 */
export function observeStore(inner: Store, log: Logger): Store {
  const wrapped: Record<string, (...a: any[]) => Promise<unknown>> = {
    async appendStep(rec: StepRecord) {
      await inner.appendStep(rec);
      log.info("step.started", stepFields(rec));
    },
    async updateStep(runId: string, step: string, attempt: number, patch: Partial<StepRecord>) {
      await inner.updateStep(runId, step, attempt, patch);
      if (patch.status === undefined) return;
      const f = stepFields({ ...patch, runId, step, attempt });
      if (patch.status === "succeeded") {
        log.info("step.succeeded", f);
        if (patch.latencyMs !== undefined) log.metric("StepDurationMs", patch.latencyMs, "Milliseconds", { Step: step });
        if (patch.costUsd !== undefined) log.metric("StepCostUsd", patch.costUsd, "None", { Step: step });
        log.metric("StepSucceeded", 1, "Count", { Step: step });
      } else if (patch.status === "failed") {
        log.error("step.failed", f);
        log.metric("StepFailed", 1, "Count", { Step: step });
      }
    },
    async updateRun(id: string, patch: Parameters<Store["updateRun"]>[1], expected?: Parameters<Store["updateRun"]>[2]) {
      const run = await inner.updateRun(id, patch, expected);
      if (patch.state !== undefined) {
        const f = { runId: id, state: patch.state, currentStep: run.currentStep };
        if (patch.state === "failed") log.error("run.failed", f);
        else log.info("run.state", f);
        log.metric("RunState", 1, "Count", { State: patch.state });
      }
      return run;
    },
    async addVersion(v: Parameters<Store["addVersion"]>[0]) {
      await inner.addVersion(v);
      log.info("version.saved", { runId: v.runId, n: v.n, author: v.author, authorRole: v.authorRole });
      log.metric("VersionSaved", 1, "Count", { AuthorRole: String(v.authorRole ?? "unknown") });
    },
    async addSignature(sig: Parameters<Store["addSignature"]>[0]) {
      const v = await inner.addSignature(sig);
      log.info("signature.added", { runId: sig.runId, n: sig.n, role: sig.role, status: v.status });
      log.metric("Signature", 1, "Count", { Role: sig.role });
      return v;
    },
    async rejectVersion(runId: string, n: number, rej: Parameters<Store["rejectVersion"]>[2]) {
      const v = await inner.rejectVersion(runId, n, rej);
      log.warn("version.rejected", { runId, n });
      log.metric("VersionRejected", 1);
      return v;
    },
    async addComment(c: Parameters<Store["addComment"]>[0]) {
      await inner.addComment(c);
      // Content is never logged; the count and the place are enough.
      log.info("comment.added", { runId: c.runId, n: c.n, itemRef: c.itemRef, author: c.author });
    },
    async appendAudit(runId: string, event: Parameters<Store["appendAudit"]>[1]) {
      await inner.appendAudit(runId, event);
      const detail = typeof event.detail === "object" && event.detail !== null ? (event.detail as Fields) : {};
      log.info("audit", { runId, type: event.type, ...cleanFields(detail) });
      log.metric("AuditEvent", 1, "Count", { Type: event.type });
    },
  };

  return new Proxy(inner, {
    get(target, prop) {
      const original = Reflect.get(target, prop) as unknown;
      if (typeof prop === "string" && prop in wrapped) {
        return async (...args: unknown[]) => {
          try {
            return await wrapped[prop]!(...args);
          } catch (e) {
            // Conflict / AlreadyExists are normal races the callers handle; anything else is a real fault.
            if (e instanceof Conflict || e instanceof AlreadyExists) log.debug("store.conflict", { op: prop, errName: errName(e) });
            else {
              log.error("store.error", { op: prop, errName: errName(e), error: errMsg(e) });
              log.metric("StoreError", 1, "Count", { Op: prop });
            }
            throw e;
          }
        };
      }
      return typeof original === "function" ? (original as (...a: unknown[]) => unknown).bind(target) : original;
    },
  }) as Store;
}

/** Wraps a ModelClient: one log line and metrics per call (latency, tokens), and a counted, logged failure. */
export function observeModel(inner: ModelClient, log: Logger, label = "model"): ModelClient {
  return {
    async generateJson(req) {
      const t0 = Date.now();
      try {
        const out = await inner.generateJson(req);
        const latencyMs = Date.now() - t0;
        const dims = { ModelId: req.modelId };
        log.info("model.call", { label, modelId: req.modelId, latencyMs, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, maxTokens: req.maxTokens });
        log.metric("ModelLatencyMs", latencyMs, "Milliseconds", dims);
        log.metric("ModelInputTokens", out.usage.inputTokens, "Count", dims);
        log.metric("ModelOutputTokens", out.usage.outputTokens, "Count", dims);
        return out;
      } catch (e) {
        const latencyMs = Date.now() - t0;
        if (e instanceof ModelOutputError) {
          // The model answered, but not in the expected shape. Callers may handle it (a plain-text refusal in chat), so this is a
          // warning with its own metric; ModelError stays for calls that really failed (throttling, access, timeouts).
          // Shape only, never content: length, number of code fences, whether it starts like JSON.
          log.warn("model.invalid_output", { label, modelId: req.modelId, latencyMs, rawChars: e.raw.length, fences: (e.raw.match(/```/g) ?? []).length / 2, startsJson: /^\s*[{[]/.test(e.raw), schemaIssues: e.issues?.length });
          log.metric("ModelOutputInvalid", 1, "Count", { ModelId: req.modelId });
          throw e;
        }
        log.error("model.error", { label, modelId: req.modelId, latencyMs, errName: errName(e), error: errMsg(e) });
        log.metric("ModelError", 1, "Count", { ModelId: req.modelId });
        throw e;
      }
    },
  };
}
