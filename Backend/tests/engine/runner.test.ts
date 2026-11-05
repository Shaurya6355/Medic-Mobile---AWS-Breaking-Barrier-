import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { MAX_ERROR_CHARS, runStep } from "../../src/engine/runner.js";
import { TransientError, UsageError, type Step, type StepContext } from "../../src/engine/step.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import type { ModelClient } from "../../src/model/modelClient.js";

const prices = { m1: { inPerMTok: 3, outPerMTok: 15 } };

async function setup() {
  const store = new MemoryStore();
  const run = { runId: "r1", state: "extracting" as const, createdAt: 0 };
  await store.createRun(run);
  let t = 1000;
  const ctx: StepContext = {
    run,
    versionId: "v1",
    store,
    artifacts: new MemoryArtifactStore(),
    model: {} as ModelClient,
    now: () => (t += 10),
  };
  const sleeps: number[] = [];
  const opts = {
    maxAttempts: 3,
    backoffMs: (a: number) => a * 100,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    prices,
  };
  return { store, ctx, opts, sleeps };
}

function stepFrom(fns: Array<() => Promise<any>>, name = "s"): Step & { calls: number } {
  const s = {
    name,
    runState: "extracting" as const,
    calls: 0,
    async run() {
      const f = fns[Math.min(s.calls, fns.length - 1)]!;
      s.calls++;
      return f();
    },
  };
  return s as Step & { calls: number };
}

const ok = async () => ({
  artifactRefs: { out: "k" },
  usage: { inputTokens: 1_000_000, outputTokens: 500_000, modelId: "m1" },
});
const transient = async () => {
  throw new TransientError("throttled");
};

describe("runStep", () => {
  it("records a successful attempt with metrics and audit", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    const rec = await runStep(stepFrom([ok]), ctx, opts);
    expect(rec).toMatchObject({
      runId: "r1",
      step: "s",
      versionId: "v1",
      attempt: 1,
      status: "succeeded",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsd: 10.5,
      modelId: "m1",
      artifactRefs: { out: "k" },
    });
    expect(rec.latencyMs).toBe(rec.endedAt! - rec.startedAt);
    expect(rec.latencyMs).toBeGreaterThan(0);
    expect(await store.listSteps("r1")).toHaveLength(1);
    expect(sleeps).toEqual([]);
    const types = (await store.listAudit("r1")).map((e) => e.type);
    expect(types).toEqual(["step_started", "step_succeeded"]);
  });

  it("leaves cost undefined for an unpriced model and handles no usage", async () => {
    const { ctx, opts } = await setup();
    const a = await runStep(
      stepFrom([async () => ({ artifactRefs: {}, usage: { inputTokens: 5, outputTokens: 6, modelId: "zz" } })], "a"),
      ctx,
      opts,
    );
    expect(a.costUsd).toBeUndefined();
    expect(a.modelId).toBe("zz");
    expect(a.inputTokens).toBe(5);
    const b = await runStep(stepFrom([async () => ({ artifactRefs: {} })], "b"), ctx, opts);
    expect(b.status).toBe("succeeded");
    expect(b.inputTokens).toBe(0);
  });

  it("retries transient errors with backoff then succeeds", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    const rec = await runStep(stepFrom([transient, transient, ok]), ctx, opts);
    expect(rec.attempt).toBe(3);
    expect(rec.status).toBe("succeeded");
    expect(sleeps).toEqual([100, 200]);
    const steps = await store.listSteps("r1");
    expect(steps.map((s) => [s.attempt, s.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"],
    ]);
    expect(steps[0]!.error).toBe("throttled");
    const types = (await store.listAudit("r1")).map((e) => e.type);
    expect(types).toEqual([
      "step_started", "step_failed", "step_retry",
      "step_started", "step_failed", "step_retry",
      "step_started", "step_succeeded",
    ]);
  });

  it("stops at once on a non-transient error", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    const step = stepFrom([async () => { throw new Error("bad input"); }]);
    const rec = await runStep(step, ctx, opts);
    expect(rec).toMatchObject({ attempt: 1, status: "failed", error: "bad input" });
    expect(step.calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await store.listSteps("r1")).toHaveLength(1);
  });

  it("uses String(e) for non-Error throws and truncates audit error text", async () => {
    const { store, ctx, opts } = await setup();
    const rec = await runStep(stepFrom([async () => { throw "boom"; }], "c"), ctx, opts);
    expect(rec.error).toBe("boom");
    const long = "x".repeat(2000);
    await runStep(stepFrom([async () => { throw new Error(long); }], "d"), ctx, opts);
    const failed = (await store.listAudit("r1")).filter((e) => e.type === "step_failed");
    const detail = failed[1]!.detail as { error: string };
    expect(detail.error.length).toBeLessThanOrEqual(500);
  });

  it("records tokens, model and cost of a failed attempt whose error carries usage", async () => {
    const { ctx, opts } = await setup();
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, modelId: "m1" };
    const rec = await runStep(stepFrom([async () => { throw new UsageError("bad output", usage); }]), ctx, opts);
    expect(rec).toMatchObject({
      status: "failed",
      error: "bad output",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      modelId: "m1",
      costUsd: 10.5,
    });
    // Duck-typed: any thrown error with a well-formed usage property counts.
    const other = Object.assign(new Error("x"), { usage: { inputTokens: 2, outputTokens: 1, modelId: "zz" } });
    const rec2 = await runStep(stepFrom([async () => { throw other; }], "o"), ctx, opts);
    expect(rec2).toMatchObject({ inputTokens: 2, outputTokens: 1, modelId: "zz" });
    expect(rec2.costUsd).toBeUndefined();
  });

  it("ignores a malformed usage property on a thrown error", async () => {
    const { ctx, opts } = await setup();
    const usages = [null, "x", { inputTokens: -1, outputTokens: 1, modelId: "m1" }, { inputTokens: 1, outputTokens: 1 }];
    for (const [i, usage] of usages.entries()) {
      const e = Object.assign(new Error("x"), { usage });
      const rec = await runStep(stepFrom([async () => { throw e; }], `m${i}`), ctx, opts);
      expect(rec).toMatchObject({ status: "failed", inputTokens: 0, outputTokens: 0 });
      expect(rec.modelId).toBeUndefined();
      expect(rec.costUsd).toBeUndefined();
    }
  });

  it("truncates the stored step error to MAX_ERROR_CHARS", async () => {
    const { store, ctx, opts } = await setup();
    expect(MAX_ERROR_CHARS).toBe(2000);
    const long = "y".repeat(5000);
    const rec = await runStep(stepFrom([async () => { throw new Error(long); }], "t"), ctx, opts);
    expect(rec.error).toBe("y".repeat(2000));
    expect((await store.listSteps("r1"))[0]!.error).toBe("y".repeat(2000));
    const failed = (await store.listAudit("r1")).filter((e) => e.type === "step_failed");
    expect((failed[0]!.detail as { error: string }).error).toBe("y".repeat(500));
  });

  it("ends failed after exhausting transient attempts", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    const step = stepFrom([transient]);
    const rec = await runStep(step, ctx, opts);
    expect(rec).toMatchObject({ attempt: 3, status: "failed", error: "throttled" });
    expect(step.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(await store.listSteps("r1")).toHaveLength(3);
  });
  it("numbers attempts from firstAttempt, still capped at maxAttempts per call", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    const step = stepFrom([transient]);
    const rec = await runStep(step, ctx, { ...opts, firstAttempt: 4 });
    expect(rec).toMatchObject({ attempt: 6, status: "failed" });
    expect(step.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect((await store.listSteps("r1")).map((s) => s.attempt)).toEqual([4, 5, 6]);
  });

  it("refuses to start an attempt when the run's cost is at the budget", async () => {
    const { store, ctx, opts } = await setup();
    await store.appendStep({ runId: "r1", step: "earlier", attempt: 1, status: "succeeded", startedAt: 1, inputTokens: 1, outputTokens: 1, costUsd: 2, artifactRefs: {} });
    const step = stepFrom([ok]);
    const rec = await runStep(step, ctx, { ...opts, runBudgetUsd: 2 });
    expect(step.calls).toBe(0);
    expect(rec).toMatchObject({ step: "s", status: "failed", attempt: 1 });
    expect(rec.error).toBe("Run budget exceeded: $2.0000 of $2.0000");
    expect((await store.listSteps("r1")).filter((r) => r.step === "s")).toHaveLength(1);
  });

  it("runs normally when the run is under the budget or no budget is set", async () => {
    const { store, ctx, opts } = await setup();
    await store.appendStep({ runId: "r1", step: "earlier", attempt: 1, status: "succeeded", startedAt: 1, inputTokens: 1, outputTokens: 1, costUsd: 1, artifactRefs: {} });
    const under = stepFrom([ok], "a");
    expect((await runStep(under, ctx, { ...opts, runBudgetUsd: 5 })).status).toBe("succeeded");
    const unset = stepFrom([ok], "b");
    expect((await runStep(unset, ctx, opts)).status).toBe("succeeded");
  });

  it("does not retry after a budget refusal", async () => {
    const { store, ctx, opts, sleeps } = await setup();
    await store.appendStep({ runId: "r1", step: "earlier", attempt: 1, status: "succeeded", startedAt: 1, inputTokens: 1, outputTokens: 1, costUsd: 9, artifactRefs: {} });
    await runStep(stepFrom([ok]), ctx, { ...opts, runBudgetUsd: 1 });
    expect(sleeps).toEqual([]);
  });

  it("counts extra spend from other sources (revision calls) against the budget", async () => {
    const { store, ctx, opts } = await setup();
    await store.appendStep({ runId: "r1", step: "earlier", attempt: 1, status: "succeeded", startedAt: 1, inputTokens: 1, outputTokens: 1, costUsd: 1, artifactRefs: {} });
    const step = stepFrom([ok]);
    const rec = await runStep(step, ctx, { ...opts, runBudgetUsd: 2, extraSpentUsd: async (runId) => (runId === "r1" ? 1.5 : 0) });
    expect(step.calls).toBe(0);
    expect(rec.error).toBe("Run budget exceeded: $2.5000 of $2.0000");
  });
});

describe("runStep logging", () => {
  it("logs each attempt's start and end with ids, timing and tokens, and a retry", async () => {
    const { ctx, opts } = await setup();
    const lines: [string, Record<string, unknown>][] = [];
    const step = stepFrom([
      async () => {
        throw new TransientError("throttled");
      },
      async () => ({ artifactRefs: { output: "k" }, usage: { inputTokens: 5, outputTokens: 2, modelId: "m1" } }),
    ]);
    await runStep(step, ctx, { ...opts, log: (m, d) => lines.push([m, d as Record<string, unknown>]) });
    expect(lines.map(([m]) => m)).toEqual(["step started", "step failed", "step started", "step succeeded"]);
    expect(lines[1]![1]).toMatchObject({ runId: "r1", step: "s", attempt: 1, transient: true, willRetry: true, error: "throttled" });
    expect(lines[3]![1]).toMatchObject({ runId: "r1", step: "s", attempt: 2, inputTokens: 5, outputTokens: 2, modelId: "m1", refs: { output: "k" } });
    expect(typeof lines[3]![1].ms).toBe("number");
  });

  it("a logger that throws never changes the result", async () => {
    const { ctx, opts } = await setup();
    const rec = await runStep(stepFrom([async () => ({ artifactRefs: {} })]), ctx, {
      ...opts,
      log: () => {
        throw new Error("broken logger");
      },
    });
    expect(rec.status).toBe("succeeded");
  });
});
