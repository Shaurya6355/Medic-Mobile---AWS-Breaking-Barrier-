import { describe, expect, it } from "vitest";
import { rowFromStep, rowsFromRevision, summarize, type UsageRow } from "../../src/metrics/usage.js";
import type { StepRecord } from "../../src/domain/types.js";
import type { Revision } from "../../src/revision/types.js";

const row = (o: Partial<UsageRow> = {}): UsageRow => ({
  process: "extract",
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.1,
  modelId: "m1",
  latencyMs: 1000,
  ...o,
});

describe("summarize", () => {
  it("sums tokens, cost and latency across rows", () => {
    const { totals } = summarize([row(), row({ process: "fill_logic", costUsd: 0.25, latencyMs: 500 })]);
    expect(totals.inputTokens).toBe(200);
    expect(totals.outputTokens).toBe(100);
    expect(totals.costUsd).toBeCloseTo(0.35);
    expect(totals.latencyMs).toBe(1500);
    expect(totals.unpricedModels).toEqual([]);
  });

  it("costUsd is null when no row is priced", () => {
    const { totals } = summarize([row({ costUsd: undefined })]);
    expect(totals.costUsd).toBeNull();
  });

  it("names a model that used tokens but had no price", () => {
    const { totals } = summarize([row(), row({ modelId: "m2", costUsd: undefined })]);
    expect(totals.unpricedModels).toEqual(["m2"]);
    expect(totals.costUsd).toBeCloseTo(0.1);
  });

  it("a zero-token row with no price is not reported as unpriced", () => {
    const { totals } = summarize([row({ inputTokens: 0, outputTokens: 0, costUsd: undefined, modelId: "m3" })]);
    expect(totals.unpricedModels).toEqual([]);
  });

  it("groups by process and by versionId", () => {
    const m = summarize([
      row({ versionId: "1" }),
      row({ process: "revision", versionId: "1", costUsd: 0.05 }),
      row({ process: "revision", versionId: "2", costUsd: 0.07 }),
      row({ process: "ingest", inputTokens: 0, outputTokens: 0, costUsd: undefined, modelId: undefined }),
    ]);
    expect(Object.keys(m.byProcess).sort()).toEqual(["extract", "ingest", "revision"]);
    expect(m.byProcess.revision?.costUsd).toBeCloseTo(0.12);
    expect(Object.keys(m.byVersion).sort()).toEqual(["1", "2"]);
    expect(m.byVersion["1"]?.costUsd).toBeCloseTo(0.15);
  });

  it("empty input gives zeros and empty groups", () => {
    expect(summarize([])).toEqual({
      totals: { inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0, unpricedModels: [] },
      byProcess: {},
      byVersion: {},
    });
  });
});

describe("rowFromStep", () => {
  const step = (o: Partial<StepRecord> = {}): StepRecord => ({
    runId: "r1",
    step: "extract",
    attempt: 1,
    status: "running",
    startedAt: 1,
    inputTokens: 0,
    outputTokens: 0,
    artifactRefs: {},
    ...o,
  });

  it("treats a missing latencyMs as 0", () => {
    expect(rowFromStep(step()).latencyMs).toBe(0);
  });

  it("carries process, version, tokens, cost and model", () => {
    expect(rowFromStep(step({ versionId: "2", inputTokens: 5, outputTokens: 6, costUsd: 0.5, modelId: "m1", latencyMs: 9 }))).toEqual({
      process: "extract",
      versionId: "2",
      inputTokens: 5,
      outputTokens: 6,
      costUsd: 0.5,
      modelId: "m1",
      latencyMs: 9,
    });
  });
});

describe("rowsFromRevision", () => {
  it("yields one row per usage entry, all process revision, keyed by fromVersion", () => {
    const rev = {
      fromVersion: 3,
      usage: [{ inputTokens: 1, outputTokens: 2, costUsd: 0.01, modelId: "m1", latencyMs: 7 }],
    } as unknown as Revision;
    expect(rowsFromRevision(rev)).toEqual([
      { process: "revision", versionId: "3", inputTokens: 1, outputTokens: 2, costUsd: 0.01, modelId: "m1", latencyMs: 7 },
    ]);
  });

  it("a revision with no usage yields no rows", () => {
    expect(rowsFromRevision({ fromVersion: 1, usage: [] } as unknown as Revision)).toEqual([]);
  });
});
