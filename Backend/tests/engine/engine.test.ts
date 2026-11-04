import { NotFound } from "../../src/artifacts/artifactStore.js";
import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/contract/schemas.js";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { Orchestrator } from "../../src/engine/engine.js";
import { TransientError, type Step, type StepResult } from "../../src/engine/step.js";
import type { ModelClient } from "../../src/model/modelClient.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import type { Store } from "../../src/store/store.js";

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

function setup(steps: Step[], opts: { store?: Store; owner?: string; clock?: { t: number }; finalState?: RunState } = {}) {
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
    ...(opts.finalState !== undefined ? { finalState: opts.finalState } : {}),
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

describe("Orchestrator with the checks step and the sign-off end state (DEC-019)", () => {
  it("runs fill_logic, then checks, and stops in awaiting_officer", async () => {
    const steps = [...flow(), fakeStep("checks", "checking")];
    const { store, orch } = setup(steps, { finalState: "awaiting_officer" });
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    expect((await store.getRun(run.runId))!.state).toBe("awaiting_officer");
    const states = (await store.listAudit(run.runId)).filter((a) => a.type === "run_state").map((a) => {
      const d = a.detail as { from: string | null; to: string };
      return `${d.from}->${d.to}`;
    });
    expect(states.slice(-2)).toEqual(["filling_logic->checking", "checking->awaiting_officer"]);
    expect((await store.listSteps(run.runId)).map((s) => s.step)).toEqual(["ingest", "extract", "fill_logic", "checks"]);
  });

  it("a failed checks step fails the run and resumes into checking", async () => {
    const steps = [...flow(), fakeStep("checks", "checking", [failHard, ok])];
    const { store, orch } = setup(steps, { finalState: "awaiting_officer" });
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    expect((await store.getRun(run.runId))!).toMatchObject({ state: "failed", currentStep: "checks" });
    await orch.resume(run.runId);
    expect((await store.getRun(run.runId))!.state).toBe("awaiting_officer");
  });

  it("refuses an end state the last step cannot reach", async () => {
    const { orch, store } = setup(flow(), { finalState: "locked" });
    const run = await orch.createRun(undefined, "doc.pdf");
    await expect(orch.onUploaded(run.runId)).rejects.toThrow(/Illegal transition/);
    expect((await store.getRun(run.runId))!.state).toBe("failed");
  });
});

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

  it("two concurrent onUploaded calls run each step once", async () => {
    const steps = flow();
    const { store, orch } = setup(steps);
    const run = await orch.createRun(undefined, "doc.pdf");
    await Promise.all([orch.onUploaded(run.runId), orch.onUploaded(run.runId)]);
    expect(steps.map((s) => s.calls)).toEqual([1, 1, 1]);
    const recs = await store.listSteps(run.runId);
    expect(recs.map((r) => [r.step, r.attempt, r.status])).toEqual([
      ["ingest", 1, "succeeded"],
      ["extract", 1, "succeeded"],
      ["fill_logic", 1, "succeeded"],
    ]);
    const after = (await store.getRun(run.runId))!;
    expect(after.state).toBe("in_review");
    expect(after.lease).toBeUndefined();
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

  it("resumeAll leaves a run with a live foreign lease alone, then resumes it once the lease expires", async () => {
    // A process was killed mid-extract; its lease is still live when the new process sweeps.
    const store = new MemoryStore();
    const runId = "r1";
    await store.createRun({ runId, state: "extracting", createdAt: 0, lease: { owner: "dead", expiresAt: 50_000 } });
    const base = { runId, inputTokens: 0, outputTokens: 0, startedAt: 10 };
    await store.appendStep({ ...base, step: "ingest", attempt: 1, status: "succeeded", artifactRefs: { blocks: "b" } });
    await store.appendStep({ ...base, step: "extract", attempt: 1, status: "running", artifactRefs: {} });

    const steps = flow();
    const clock = { t: 1000 };
    const { orch } = setup(steps, { store, owner: "B", clock });

    await orch.resumeAll();
    let after = (await store.getRun(runId))!;
    expect(after.state).toBe("extracting");
    expect(after.lease).toEqual({ owner: "dead", expiresAt: 50_000 });
    expect(steps.map((s) => s.calls)).toEqual([0, 0, 0]);

    clock.t = 50_001;
    await orch.resumeAll();
    after = (await store.getRun(runId))!;
    expect(after.state).toBe("in_review");
    expect(after.lease).toBeUndefined();
    expect(steps.map((s) => s.calls)).toEqual([0, 1, 1]);
    const recs = await store.listSteps(runId);
    expect(recs.map((r) => [r.step, r.attempt, r.status, r.error])).toEqual([
      ["ingest", 1, "succeeded", undefined],
      ["extract", 1, "failed", "abandoned"],
      ["extract", 2, "succeeded", undefined],
      ["fill_logic", 1, "succeeded", undefined],
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
  it("stops when the lease is taken by another owner mid-run and leaves that lease alone", async () => {
    const store = new MemoryStore();
    let runId = "";
    const steps = flow({
      extract: [
        async () => {
          // Our lease lapsed and another owner took the run while this step ran.
          await store.updateRun(runId, { lease: { owner: "B", expiresAt: 10_000_000 } });
          return { artifactRefs: {} };
        },
      ],
    });
    const { orch } = setup(steps, { store, owner: "A" });
    runId = (await orch.createRun(undefined, "doc.pdf")).runId;
    await orch.onUploaded(runId);

    const after = (await store.getRun(runId))!;
    expect(after.state).toBe("extracting");
    expect(after.lease).toEqual({ owner: "B", expiresAt: 10_000_000 });
    expect(steps.map((s) => s.calls)).toEqual([1, 1, 0]);
  });

  it("renews the lease before each step", async () => {
    const store = new MemoryStore();
    const clock = { t: 1000 };
    const expiries: number[] = [];
    let runId = "";
    const record = async () => {
      expiries.push((await store.getRun(runId))!.lease!.expiresAt);
      clock.t += LEASE_MS; // each step takes a whole lease period
      return { artifactRefs: {} };
    };
    const steps = flow({ ingest: [record], extract: [record], fill_logic: [record] });
    const { orch } = setup(steps, { store, clock });
    runId = (await orch.createRun(undefined, "doc.pdf")).runId;
    await orch.onUploaded(runId);
    expect((await store.getRun(runId))!.state).toBe("in_review");
    expect(expiries).toHaveLength(3);
    expect(expiries[1]! - expiries[0]!).toBeGreaterThanOrEqual(LEASE_MS);
    expect(expiries[2]! - expiries[1]!).toBeGreaterThanOrEqual(LEASE_MS);
  });

  it("a store error mid-run fails the run with currentStep, rethrows, and resume completes it", async () => {
    const inner = new MemoryStore();
    let failOnce = true;
    const store = wrap(inner, {
      async updateStep(runId, step, attempt, patch) {
        if (step === "extract" && failOnce) {
          failOnce = false;
          throw new Error("store down");
        }
        return inner.updateStep(runId, step, attempt, patch);
      },
    });
    const steps = flow();
    const { orch } = setup(steps, { store });
    const run = await orch.createRun(undefined, "doc.pdf");
    await expect(orch.onUploaded(run.runId)).rejects.toThrow("store down");

    let after = (await inner.getRun(run.runId))!;
    expect(after).toMatchObject({ state: "failed", currentStep: "extract" });
    expect(after.lease).toBeUndefined();

    await orch.resume(run.runId);
    after = (await inner.getRun(run.runId))!;
    expect(after.state).toBe("in_review");
    expect(steps.map((s) => s.calls)).toEqual([1, 2, 1]);
    const extracts = (await inner.listSteps(run.runId)).filter((r) => r.step === "extract");
    expect(extracts.map((r) => [r.attempt, r.status, r.error])).toEqual([
      [1, "failed", "abandoned"],
      [2, "succeeded", undefined],
    ]);
  });

  it("a release error does not mask the original error", async () => {
    const inner = new MemoryStore();
    const store = wrap(inner, {
      async listSteps() {
        throw new Error("original");
      },
      async releaseLease() {
        throw new Error("release failed");
      },
    });
    const { orch } = setup(flow(), { store });
    const run = await orch.createRun(undefined, "doc.pdf");
    await expect(orch.onUploaded(run.runId)).rejects.toThrow("original");
  });

  it("resumeAll continues past a poisoned run and records resume_error on it", async () => {
    const inner = new MemoryStore();
    await inner.createRun({ runId: "bad", state: "extracting", createdAt: 0 });
    await inner.createRun({ runId: "good", state: "extracting", createdAt: 0 });
    await inner.createRun({ runId: "mute", state: "extracting", createdAt: 0 });
    const store = wrap(inner, {
      async listSteps(runId) {
        if (runId !== "good") throw new Error("poison ".repeat(200));
        return inner.listSteps(runId);
      },
      async appendAudit(runId, event) {
        if (runId === "mute") throw new Error("audit down");
        return inner.appendAudit(runId, event);
      },
    });
    const steps = flow();
    const { orch } = setup(steps, { store });
    await expect(orch.resumeAll()).resolves.toBeUndefined();

    expect((await inner.getRun("good"))!.state).toBe("in_review");
    expect(await inner.getRun("bad")).toMatchObject({ state: "failed", currentStep: "extract" });
    const errors = (await inner.listAudit("bad")).filter((e) => e.type === "resume_error");
    expect(errors).toHaveLength(1);
    const detail = errors[0]!.detail as { error: string };
    expect(detail.error.startsWith("poison")).toBe(true);
    expect(detail.error.length).toBeLessThanOrEqual(500);
  });

  it("lastStatusChange is undefined until the busy/idle status changes, then stamps each change", async () => {
    let during: number | undefined;
    const steps = flow({ ingest: [async () => { during = orch.lastStatusChange(); return { artifactRefs: { out: "x" } }; }] });
    const { orch } = setup(steps);
    expect(orch.lastStatusChange()).toBeUndefined();
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    expect(during).toBeDefined();
    const after = orch.lastStatusChange();
    expect(after).toBeGreaterThan(during as number);
  });

  it("onUploaded for an unknown run rejects with NotFound", async () => {
    const { orch } = setup(flow());
    await expect(orch.onUploaded("missing")).rejects.toBeInstanceOf(NotFound);
  });

  it("activeCount is 0 when idle, 1 while advancing and 0 after, even on failure", async () => {
    let seen = -1;
    const steps = flow({ ingest: [async () => { seen = orch.activeCount(); return { artifactRefs: { out: "x" } }; }] });
    const { orch } = setup(steps);
    expect(orch.activeCount()).toBe(0);
    const run = await orch.createRun(undefined, "doc.pdf");
    await orch.onUploaded(run.runId);
    expect(seen).toBe(1);
    expect(orch.activeCount()).toBe(0);
    await expect(orch.advance("missing")).rejects.toThrow();
    expect(orch.activeCount()).toBe(0);
  });


  describe("total attempt cap per step", () => {
    const hang = () => new Promise<StepResult>(() => {});
    const alwaysTransient = [transient];

    it("counts attempts abandoned by cut-off invocations and fails the step beyond the cap of 6", async () => {
      // Each invocation is cut off while the step hangs (never awaited); the next owner takes over
      // after the lease expires, as the scheduled sweep does.
      const store = new MemoryStore();
      const clock = { t: 1000 };
      const first = setup(flow({ extract: [hang] }), { store, clock, owner: "o0" });
      const run = await first.orch.createRun(undefined, "doc.pdf");
      void first.orch.onUploaded(run.runId);
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 5));
        clock.t += LEASE_MS + 1;
        const next = setup(flow({ extract: [hang] }), { store, clock, owner: `o${i}` });
        void next.orch.resumeAll();
      }
      await new Promise((r) => setTimeout(r, 5));
      const attempts = (await store.listSteps(run.runId)).filter((r) => r.step === "extract");
      expect(attempts).toHaveLength(6);

      // Seventh takeover: the cap is reached, the step is not started again.
      clock.t += LEASE_MS + 1;
      const steps = flow({ extract: [hang] });
      const last = setup(steps, { store, clock, owner: "o6" });
      await last.orch.resumeAll();
      const after = (await store.getRun(run.runId))!;
      expect(after.state).toBe("failed");
      expect(after.currentStep).toBe("extract");
      expect(steps[1]!.calls).toBe(0);
      const recs = (await store.listSteps(run.runId)).filter((r) => r.step === "extract");
      const capped = recs[recs.length - 1]!;
      expect(capped.status).toBe("failed");
      expect(capped.error).toMatch(/attempt cap/i);
      expect(capped.error).toMatch(/6/);
    });

    it("limits a fresh invocation to the remaining budget", async () => {
      const store = new MemoryStore();
      const steps = flow({ extract: alwaysTransient });
      const { orch } = setup(steps, { store });
      const run = await orch.createRun(undefined, "doc.pdf");
      await store.updateRun(run.runId, { state: "extracting" });
      for (let a = 1; a <= 4; a++) {
        await store.appendStep({ runId: run.runId, step: "extract", attempt: a, status: "running", startedAt: 1, inputTokens: 0, outputTokens: 0, artifactRefs: {} });
      }
      await orch.advance(run.runId);
      expect(steps[1]!.calls).toBe(2);
      const after = (await store.getRun(run.runId))!;
      expect(after.state).toBe("failed");
      expect((await store.listSteps(run.runId)).filter((r) => r.step === "extract")).toHaveLength(6);
    });

    it("a manual resume starts a fresh budget", async () => {
      const store = new MemoryStore();
      const steps = flow({ extract: [ok] });
      const { orch } = setup(steps, { store });
      const run = await orch.createRun(undefined, "doc.pdf");
      await store.updateRun(run.runId, { state: "extracting" });
      for (let a = 1; a <= 6; a++) {
        await store.appendStep({ runId: run.runId, step: "extract", attempt: a, status: "failed", startedAt: 1, endedAt: 2, inputTokens: 0, outputTokens: 0, artifactRefs: {} });
      }
      await orch.advance(run.runId);
      expect((await store.getRun(run.runId))!.state).toBe("failed");
      expect(steps[1]!.calls).toBe(0);
      await orch.resume(run.runId);
      expect(steps[1]!.calls).toBe(1);
      expect((await store.getRun(run.runId))!.state).toBe("in_review");
    });
  });

  describe("prepareResume", () => {
    it("moves a failed run to its step state, without a lease, without running anything", async () => {
      const steps = flow({ extract: [failHard, ok] });
      const { store, orch } = setup(steps);
      const run = await orch.createRun(undefined, "doc.pdf");
      await orch.onUploaded(run.runId);
      expect((await store.getRun(run.runId))!.state).toBe("failed");
      const calls = steps.map((s) => s.calls);
      await orch.prepareResume(run.runId);
      const after = (await store.getRun(run.runId))!;
      expect(after.state).toBe("extracting");
      expect(after.lease).toBeUndefined();
      expect(steps.map((s) => s.calls)).toEqual(calls);
    });
    it("leaves the run for listResumable, so the sweep advances it", async () => {
      const steps = flow({ extract: [failHard, ok] });
      const { store, orch, clock } = setup(steps);
      const run = await orch.createRun(undefined, "doc.pdf");
      await orch.onUploaded(run.runId);
      await orch.prepareResume(run.runId);
      expect((await store.listResumable(clock.t)).map((r) => r.runId)).toEqual([run.runId]);
      await orch.resumeAll();
      expect((await store.getRun(run.runId))!.state).toBe("in_review");
    });
    it("rejects a run that is not failed", async () => {
      const { orch } = setup(flow());
      const run = await orch.createRun(undefined, "doc.pdf");
      await expect(orch.prepareResume(run.runId)).rejects.toThrow(/not failed/);
    });
  });
});

// Delegates every Store method to inner except the overrides.
function wrap(inner: MemoryStore, overrides: Partial<Store>): Store {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const o = (overrides as Record<string | symbol, unknown>)[prop];
      if (o) return o;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Store;
}

describe("Orchestrator onFinalState hook", () => {
  it("fires once after the last step with the lease released; hook errors are dropped; resumeAll re-fires for awaiting_officer", async () => {
    const seen: string[] = [];
    const store = new MemoryStore();
    let leaseFreeInHook = false;
    const orch = new Orchestrator({
      store,
      artifacts: new MemoryArtifactStore(),
      model: {} as ModelClient,
      steps: [...flow(), fakeStep("checks", "checking")],
      owner: "A",
      leaseMs: LEASE_MS,
      runnerOpts: { maxAttempts: 1, backoffMs: () => 0, sleep: async () => {}, prices: {} },
      finalState: "awaiting_officer",
      onFinalState: async (id) => {
        seen.push(id);
        leaseFreeInHook = (await store.acquireLease(id, "other", LEASE_MS, 5_000_000)) === true;
        throw new Error("hook boom");
      },
    });
    const run = await orch.createRun(undefined, "f.pdf");
    await orch.onUploaded(run.runId);
    expect(seen).toEqual([run.runId]);
    expect(leaseFreeInHook).toBe(true);
    expect((await store.getRun(run.runId))!.state).toBe("awaiting_officer");
    expect((await store.listAudit(run.runId)).some((e) => e.type === "final_state_hook_error")).toBe(true);
    await orch.resumeAll();
    expect(seen).toEqual([run.runId, run.runId]);
  });
});
