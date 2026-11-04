import { cost, type PriceTable } from "../metrics/cost.js";
import type { StepRecord } from "../domain/types.js";
import { TransientError, type Step, type StepContext } from "./step.js";

export interface RunStepOptions {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  prices: PriceTable;
}

const MAX_ERROR_CHARS = 500;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runStep(step: Step, ctx: StepContext, opts: RunStepOptions): Promise<StepRecord> {
  const { store, run } = ctx;
  let last: StepRecord | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
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
      if (result.usage) {
        const { inputTokens, outputTokens, modelId } = result.usage;
        patch.inputTokens = inputTokens;
        patch.outputTokens = outputTokens;
        patch.modelId = modelId;
        patch.costUsd = cost(opts.prices, modelId, inputTokens, outputTokens);
      }
    } catch (e) {
      const endedAt = ctx.now();
      transient = e instanceof TransientError;
      patch = {
        status: "failed",
        endedAt,
        latencyMs: endedAt - startedAt,
        error: errorText(e),
      };
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
    if (!transient || attempt >= opts.maxAttempts) return last;

    await store.appendAudit(run.runId, {
      at: ctx.now(),
      type: "step_retry",
      detail: { step: step.name, attempt, nextAttempt: attempt + 1 },
    });
    await opts.sleep(opts.backoffMs(attempt));
  }
  return last!;
}
