import { cost, type PriceTable } from "../metrics/cost.js";
import type { StepRecord } from "../domain/types.js";
import { TransientError, usageOf, type Step, type StepContext, type StepUsage } from "./step.js";

export interface RunStepOptions {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  prices: PriceTable;
  // Number of the first attempt in this call (default 1), so a resumed step
  // does not reuse attempt numbers already stored for it.
  firstAttempt?: number;
}

const MAX_ERROR_CHARS = 500;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function usagePatch(prices: PriceTable, u: StepUsage): Partial<StepRecord> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    modelId: u.modelId,
    costUsd: cost(prices, u.modelId, u.inputTokens, u.outputTokens),
  };
}

export async function runStep(step: Step, ctx: StepContext, opts: RunStepOptions): Promise<StepRecord> {
  const { store, run } = ctx;
  let last: StepRecord | undefined;
  const first = opts.firstAttempt ?? 1;
  const lastAttempt = first + opts.maxAttempts - 1;

  for (let attempt = first; attempt <= lastAttempt; attempt++) {
    const startedAt = ctx.now();
    const base: StepRecord = {
      runId: run.runId,
      step: step.name,
      versionId: ctx.versionId,
      attempt,
      status: "running",
      startedAt,
      inputTokens: 0,
      outputTokens: 0,
      artifactRefs: {},
    };
    await store.appendStep(base);
    await store.appendAudit(run.runId, {
      at: startedAt,
      type: "step_started",
      detail: { step: step.name, attempt },
    });

    let transient = false;
    let patch: Partial<StepRecord>;
    try {
      const result = await step.run(ctx);
      const endedAt = ctx.now();
      patch = {
        status: "succeeded",
        endedAt,
        latencyMs: endedAt - startedAt,
        artifactRefs: result.artifactRefs,
      };
      if (result.usage) Object.assign(patch, usagePatch(opts.prices, result.usage));
    } catch (e) {
      const endedAt = ctx.now();
      transient = e instanceof TransientError;
      patch = {
        status: "failed",
        endedAt,
        latencyMs: endedAt - startedAt,
        error: errorText(e),
      };
      const usage = usageOf(e);
      if (usage) Object.assign(patch, usagePatch(opts.prices, usage));
    }

    await store.updateStep(run.runId, step.name, attempt, patch);
    last = { ...base, ...patch };

    if (last.status === "succeeded") {
      await store.appendAudit(run.runId, {
        at: last.endedAt!,
        type: "step_succeeded",
        detail: { step: step.name, attempt },
      });
      return last;
    }

    await store.appendAudit(run.runId, {
      at: last.endedAt!,
      type: "step_failed",
      detail: { step: step.name, attempt, error: (last.error ?? "").slice(0, MAX_ERROR_CHARS) },
    });
    if (!transient || attempt >= lastAttempt) return last;

    await store.appendAudit(run.runId, {
      at: ctx.now(),
      type: "step_retry",
      detail: { step: step.name, attempt, nextAttempt: attempt + 1 },
    });
    await opts.sleep(opts.backoffMs(attempt - first + 1));
  }
  return last!;
}
