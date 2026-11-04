import { MAX_ERROR_CHARS } from "../engine/runner.js";
import { AlreadyExists, type Store } from "../store/store.js";

export interface RecordProcessOptions {
  runId: string;
  process: string;
  versionId?: string;
  now: () => number;
}

// The attempt number is the next free one for (run, process). appendStep refuses a number that is
// already taken (AlreadyExists), so a collision with another worker, or another call in this
// process, just takes the next number.
const MAX_APPEND_TRIES = 8;

async function appendRunning(store: Store, opts: RecordProcessOptions, startedAt: number): Promise<number> {
  const { runId, process: step, versionId } = opts;
  for (let tries = 0; ; tries++) {
    const existing = (await store.listSteps(runId)).filter((r) => r.step === step);
    const n = existing.reduce((max, r) => Math.max(max, r.attempt), 0) + 1;
    try {
      await store.appendStep({
        runId,
        step,
        ...(versionId !== undefined ? { versionId } : {}),
        attempt: n,
        status: "running",
        startedAt,
        inputTokens: 0,
        outputTokens: 0,
        artifactRefs: {},
      });
      return n;
    } catch (e) {
      if (!(e instanceof AlreadyExists) || tries + 1 >= MAX_APPEND_TRIES) throw e;
    }
  }
}

// Records a non-pipeline process (validation, compile, ...) as a step record, so its latency
// lands in the same per-run totals as the pipeline steps (DEC-003). It carries no tokens.
export async function recordProcess<T>(store: Store, opts: RecordProcessOptions, fn: () => Promise<T>): Promise<T> {
  const { runId, process: step } = opts;
  const startedAt = opts.now();
  const attempt = await appendRunning(store, opts, startedAt);
  // Bookkeeping is best effort: it must never change the outcome of the process itself.
  const finish = async (patch: Parameters<Store["updateStep"]>[3]): Promise<void> => {
    try {
      await store.updateStep(runId, step, attempt, patch);
    } catch {
      // The record stays "running"; it counts as 0 latency in the totals.
    }
  };
  try {
    const result = await fn();
    const endedAt = opts.now();
    await finish({ status: "succeeded", endedAt, latencyMs: endedAt - startedAt });
    return result;
  } catch (e) {
    const endedAt = opts.now();
    const error = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);
    await finish({ status: "failed", endedAt, latencyMs: endedAt - startedAt, error });
    throw e;
  }
}
