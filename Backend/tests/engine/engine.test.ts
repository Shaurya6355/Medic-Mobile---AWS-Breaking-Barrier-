import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/contract/schemas.js";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { Orchestrator } from "../../src/engine/engine.js";
import { TransientError, type Step, type StepResult } from "../../src/engine/step.js";
import type { ModelClient } from "../../src/model/modelClient.js";
import { MemoryStore } from "../../src/store/memoryStore.js";

const LEASE_MS = 60_000;

type FakeStep = Step & { calls: number };

function fakeStep(name: string, runState: RunState, fns: Array<() => Promise<StepResult>> = []): FakeStep {
  const s = {
    name,
    runState,
    calls: 0,
    async run() {
      const f = fns[Math.min(s.calls, fns.length - 1)];
      s.calls++;
      return f ? f() : { artifactRefs: { out: `${name}-out` } };
    },
  };
  return s as FakeStep;
}

function flow(overrides: Partial<Record<"ingest" | "extract" | "fill_logic", Array<() => Promise<StepResult>>>> = {}) {
  return [
    fakeStep("ingest", "ingesting", overrides.ingest),
    fakeStep("extract", "extracting", overrides.extract),
    fakeStep("fill_logic", "filling_logic", overrides.fill_logic),
  ];
}

function setup(steps: Step[], opts: { store?: MemoryStore; owner?: string; clock?: { t: number } } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = opts.clock ?? { t: 1000 };
  const sleeps: number[] = [];
  const orch = new Orchestrator({
    store,
    artifacts: new MemoryArtifactStore(),
    model: {} as ModelClient,
    steps,
    owner: opts.owner ?? "A",
    leaseMs: LEASE_MS,
    runnerOpts: {
      maxAttempts: 3,
      backoffMs: (a) => a * 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      prices: {},
    },
    now: () => clock.t++,
  });
  return { store, orch, clock, sleeps };
}

const failHard = async (): Promise<StepResult> => {
  throw new Error("bad input");
};
const transient = async (): Promise<StepResult> => {
  throw new TransientError("throttled");
};
const ok = async (): Promise<StepResult> => ({ artifactRefs: { out: "ok" } });

describe("Orchestrator", () => {
  it("creates a run in state created with audit", async () => {
    const { store, orch } = setup(flow());
    const run = await orch.createRun([1, 2], "doc.pdf");
    expect(run.state).toBe("created");
    expect(run.pages).toEqual([1, 2]);
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.getRun(run.runId)).toEqual(run);
    const audit = await store.listAudit(run.runId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: "run_state", detail: { from: null, to: "created" } });
  });

  it("runs the full flow to in_review with 3 succeeded records in order", async () => {
    const steps = flow();
    const { store, orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId, "abc123");

    const after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("in_review");
    expect(after.docSha256).toBe("abc123");
    expect(after.lease).toBeUndefined();
    const recs = await store.listSteps(run.runId);
    expect(recs.map((r) => [r.step, r.status, r.attempt])).toEqual([
      ["ingest", "succeeded", 1],
      ["extract", "succeeded", 1],
      ["fill_logic", "succeeded", 1],
    ]);
    const transitions = (await store.listAudit(run.runId))
      .filter((e) => e.type === "run_state")
      .map((e) => e.detail as { from: string | null; to: string })
      .map((d) => `${d.from}->${d.to}`);
    expect(transitions).toEqual([
      "null->created",
      "created->ingesting",
      "ingesting->extracting",
      "extracting->filling_logic",
      "filling_logic->in_review",
    ]);
  });

  it("passes the current run and context to each step", async () => {
    const seen: Array<{ state: RunState; versionId: unknown; now: number }> = [];
    const steps = flow().map((s) => ({
      ...s,
      run: async (ctx: Parameters<Step["run"]>[0]) => {
        seen.push({ state: ctx.run.state, versionId: ctx.versionId, now: ctx.now() });
        return { artifactRefs: {} };
      },
    }));
    const { orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    expect(seen.map((s) => s.state)).toEqual(["ingesting", "extracting", "filling_logic"]);
    expect(seen.every((s) => s.versionId === undefined && typeof s.now === "number")).toBe(true);
  });

  it("onUploaded twice runs each step once", async () => {
    const steps = flow();
    const { store, orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId, "abc");
    await orch.onUploaded(run.runId, "other");
    expect(steps.map((s) => s.calls)).toEqual([1, 1, 1]);
    expect(await store.listSteps(run.runId)).toHaveLength(3);
    expect((await store.getRun(run.runId))!.docSha256).toBe("abc");
  });

  it("a non-transient failure leaves the run failed with currentStep; resume re-runs only that step", async () => {
    const steps = flow({ extract: [failHard, ok] });
    const { store, orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);

    let after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("failed");
    expect(after.currentStep).toBe("extract");
    expect(after.lease).toBeUndefined();
    expect(steps.map((s) => s.calls)).toEqual([1, 1, 0]);

    await orch.resume(run.runId);
    after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("in_review");
    expect(after.currentStep).toBeUndefined();
    expect(steps.map((s) => s.calls)).toEqual([1, 2, 1]);
    const recs = await store.listSteps(run.runId);
    expect(recs.map((r) => [r.step, r.attempt, r.status])).toEqual([
      ["ingest", 1, "succeeded"],
      ["extract", 1, "failed"],
      ["extract", 2, "succeeded"],
      ["fill_logic", 1, "succeeded"],
    ]);
    const transitions = (await store.listAudit(run.runId))
      .filter((e) => e.type === "run_state")
      .map((e) => e.detail as { from: string; to: string });
    expect(transitions).toContainEqual({ from: "extracting", to: "failed" });
    expect(transitions).toContainEqual({ from: "failed", to: "extracting" });
  });

  it("leaves the run failed after exhausting retries on a transient step", async () => {
    const steps = flow({ fill_logic: [transient] });
    const { store, orch, sleeps } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    const after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("failed");
    expect(after.currentStep).toBe("fill_logic");
    expect(steps[2]!.calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    const fills = (await store.listSteps(run.runId)).filter((r) => r.step === "fill_logic");
    expect(fills.map((r) => [r.attempt, r.status, r.error])).toEqual([
      [1, "failed", "throttled"],
      [2, "failed", "throttled"],
      [3, "failed", "throttled"],
    ]);
  });

  it("a step throwing a non-Error fails the run, and resume completes it", async () => {
    const steps = flow({
      ingest: [
        async () => {
          throw "crash";
        },
        ok,
      ],
    });
    const { store, orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    let after = (await store.getRun(run.runId))!;
    expect(after).toMatchObject({ state: "failed", currentStep: "ingest" });
    expect((await store.listSteps(run.runId))[0]).toMatchObject({ status: "failed", error: "crash" });

    await orch.resume(run.runId);
    after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("in_review");
    expect(steps.map((s) => s.calls)).toEqual([2, 1, 1]);
  });

  it("resume throws for a run that is not failed", async () => {
    const { orch } = setup(flow());
    const run = await orch.createRun(undefined, "doc.pdf");
    await expect(orch.resume(run.runId)).rejects.toThrow(/not failed/);
  });

  it("after a crash a new instance's resumeAll completes without re-running succeeded steps", async () => {
    // State left behind by an instance discarded after extract succeeded,
    // part way into fill_logic.
    const store = new MemoryStore();
    const runId = "r1";
    await store.createRun({ runId, state: "filling_logic", createdAt: 0, lease: { owner: "dead", expiresAt: 500 } });
    const base = { runId, inputTokens: 0, outputTokens: 0, startedAt: 10 };
    await store.appendStep({ ...base, step: "ingest", attempt: 1, status: "succeeded", artifactRefs: { blocks: "b" } });
    await store.appendStep({ ...base, step: "extract", attempt: 1, status: "succeeded", artifactRefs: { out: "e" } });
    await store.appendStep({ ...base, step: "fill_logic", attempt: 1, status: "running", artifactRefs: {} });

    const steps = flow();
    const { orch } = setup(steps, { store, owner: "B", clock: { t: 1000 } });
    await orch.resumeAll();

    const after = (await store.getRun(runId))!;
    expect(after.state).toBe("in_review");
    expect(after.lease).toBeUndefined();
    expect(steps.map((s) => s.calls)).toEqual([0, 0, 1]);
    const recs = await store.listSteps(runId);
    expect(recs.map((r) => [r.step, r.attempt, r.status, r.error])).toEqual([
      ["ingest", 1, "succeeded", undefined],
      ["extract", 1, "succeeded", undefined],
      ["fill_logic", 1, "failed", "abandoned"],
      ["fill_logic", 2, "succeeded", undefined],
    ]);
  });

  it("skips a step that already succeeded even if the run state still names it", async () => {
    // Crash between the step succeeding and the state moving on.
    const store = new MemoryStore();
    await store.createRun({ runId: "r1", state: "extracting", createdAt: 0 });
    const base = { runId: "r1", inputTokens: 0, outputTokens: 0, startedAt: 10, attempt: 1 };
    await store.appendStep({ ...base, step: "ingest", status: "succeeded", artifactRefs: {} });
    await store.appendStep({ ...base, step: "extract", status: "succeeded", artifactRefs: {} });
    const steps = flow();
    const { orch } = setup(steps, { store });
    await orch.resumeAll();
    expect((await store.getRun("r1"))!.state).toBe("in_review");
    expect(steps.map((s) => s.calls)).toEqual([0, 0, 1]);
  });

  it("a second instance cannot advance a run whose lease is live", async () => {
    const store = new MemoryStore();
    const clock = { t: 1000 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stepsA = flow({
      extract: [
        async () => {
          await gate;
          return { artifactRefs: {} };
        },
      ],
    });
    const stepsB = flow();
    const a = setup(stepsA, { store, owner: "A", clock });
    const b = setup(stepsB, { store, owner: "B", clock });

    const run = await a.orch.createRun(undefined, "doc.pdf");
    const running = a.orch.onUploaded(run.runId);
    // Let A get into the extract step and block there.
    while (stepsA[1]!.calls === 0) await new Promise((r) => setImmediate(r));

    await b.orch.advance(run.runId);
    await b.orch.resumeAll();
    expect(stepsB.map((s) => s.calls)).toEqual([0, 0, 0]);
    const mid = (await store.getRun(run.runId))!;
    expect(mid.state).toBe("extracting");
    expect(mid.lease?.owner).toBe("A");

    release();
    await running;
    expect((await store.getRun(run.runId))!.state).toBe("in_review");
    expect(stepsA.map((s) => s.calls)).toEqual([1, 1, 1]);
  });
});
