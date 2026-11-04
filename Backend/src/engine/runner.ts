import { cost, type PriceTable } from "../metrics/cost.js";
import type { StepRecord } from "../domain/types.js";
import { TransientError, usageOf, type Step, type StepContext, type StepUsage } from "./step.js";

export interface RunStepOptions {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  prices: PriceTable;
  // Optional cap on the cost already recorded for the run (step records plus extraSpentUsd). When reached,
  // no further attempt starts; the attempt is recorded as failed and not retried.
  runBudgetUsd?: number;
  // Spend recorded outside the step records (for example revision model calls), added to the budget check.
  extraSpentUsd?: (runId: string) => Promise<number>;
  // Number of the first attempt in this call (default 1), so a resumed step
  // does not reuse attempt numbers already stored for it.
  firstAttempt?: number;
}

// Longest error text stored on a StepRecord; the audit copy is shorter.
export const MAX_ERROR_CHARS = 2000;
const AUDIT_ERROR_CHARS = 500;

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
    if (opts.runBudgetUsd !== undefined) {
      const stepSpent = (await store.listSteps(run.runId)).reduce((a, r) => a + (r.costUsd ?? 0), 0);
      const spent = stepSpent + (opts.extraSpentUsd ? await opts.extraSpentUsd(run.runId) : 0);
      if (spent >= opts.runBudgetUsd) {
        const refused: StepRecord = {
          runId: run.runId,
          step: step.name,
          versionId: ctx.versionId,
          attempt,
          status: "failed",
          startedAt,
          endedAt: startedAt,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          artifactRefs: {},
          error: `Run budget exceeded: $${spent.toFixed(4)} of $${opts.runBudgetUsd.toFixed(4)}`,
        };
        await store.appendStep(refused);
        await store.appendAudit(run.runId, {
          at: startedAt,
          type: "step_failed",
          detail: { step: step.name, attempt, error: (refused.error ?? "").slice(0, AUDIT_ERROR_CHARS) },
        });
        return refused;
      }
    }
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
        error: errorText(e).slice(0, MAX_ERROR_CHARS),
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
      detail: { step: step.name, attempt, error: (last.error ?? "").slice(0, AUDIT_ERROR_CHARS) },
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
