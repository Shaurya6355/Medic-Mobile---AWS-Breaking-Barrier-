import { describe, expect, it } from "vitest";
import { recordProcess } from "../../src/metrics/record.js";
import { rowFromStep, summarize } from "../../src/metrics/usage.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { AlreadyExists } from "../../src/store/store.js";

function setup() {
  const store = new MemoryStore();
  let t = 1000;
  const now = () => (t += 50);
  return { store, now };
}

describe("recordProcess", () => {
  it("records a succeeded process with latency and version, and returns the result", async () => {
    const { store, now } = setup();
    const out = await recordProcess(store, { runId: "r1", process: "validate", versionId: "2", now }, async () => "done");
    expect(out).toBe("done");
    const recs = await store.listSteps("r1");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ step: "validate", versionId: "2", status: "succeeded", attempt: 1, inputTokens: 0, outputTokens: 0 });
    expect(recs[0]?.latencyMs).toBeGreaterThan(0);
    expect(recs[0]?.endedAt).toBeGreaterThan(recs[0]?.startedAt ?? Infinity);
  });

  it("a second run of the same process gets attempt 2 and keeps attempt 1", async () => {
    const { store, now } = setup();
    await recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, async () => 1);
    await recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, async () => 2);
    const recs = await store.listSteps("r1");
    expect(recs.map((r) => r.attempt).sort()).toEqual([1, 2]);
    expect(recs.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("two overlapping runs of the same process never share an attempt", async () => {
    const { store, now } = setup();
    const slow = () => new Promise<void>((r) => setTimeout(r, 5));
    await Promise.all([
      recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, slow),
      recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, slow),
    ]);
    const attempts = (await store.listSteps("r1")).map((r) => r.attempt).sort();
    expect(attempts).toEqual([1, 2]);
  });

  it("records a failure and rethrows the same error object", async () => {
    const { store, now } = setup();
    const boom = new Error("boom");
    await expect(recordProcess(store, { runId: "r1", process: "compile", now }, async () => { throw boom; })).rejects.toBe(boom);
    const [rec] = await store.listSteps("r1");
    expect(rec).toMatchObject({ step: "compile", status: "failed", error: "boom" });
  });

  it("adds latency but no tokens or cost to the totals", async () => {
    const { store, now } = setup();
    await recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, async () => 0);
    const m = summarize((await store.listSteps("r1")).map(rowFromStep));
    expect(m.totals.costUsd).toBeNull();
    expect(m.totals.inputTokens).toBe(0);
    expect(m.totals.latencyMs).toBeGreaterThan(0);
    expect(m.byVersion["1"]?.latencyMs).toBeGreaterThan(0);
  });

  it("a bookkeeping failure does not hide the result of the process", async () => {
    const { store, now } = setup();
    store.updateStep = async () => {
      throw new Error("store down");
    };
    await expect(recordProcess(store, { runId: "r1", process: "validate", now }, async () => "ok")).resolves.toBe("ok");
  });

  it("takes the next attempt when another worker took the number first", async () => {
    const { store, now } = setup();
    const real = store.appendStep.bind(store);
    let first = true;
    store.appendStep = async (rec) => {
      if (first) {
        first = false;
        // Another worker wrote attempt 1 between our read and our append.
        await real({ ...rec, status: "succeeded" });
        throw new AlreadyExists("taken");
      }
      return real(rec);
    };
    await recordProcess(store, { runId: "r1", process: "validate", versionId: "1", now }, async () => "ok");
    const recs = await store.listSteps("r1");
    expect(recs.map((r) => r.attempt).sort()).toEqual([1, 2]);
    expect(recs.find((r) => r.attempt === 2)?.status).toBe("succeeded");
  });
});
