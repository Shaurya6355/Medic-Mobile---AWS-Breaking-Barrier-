import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRunMetrics } from "../../src/metrics/analyze.js";
import { instrumentModel } from "../../src/metrics/calls.js";
import { renderCsv, renderHtml, renderText } from "../../src/metrics/render.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import type { CallRecord, Run, StepRecord } from "../../src/domain/types.js";

const run: Run = { runId: "r1", state: "awaiting_officer", createdAt: 0 };
const call = (seq: number, startedAt: number, latencyMs: number, backend: CallRecord["backend"] = "bedrock"): CallRecord => ({
  seq, backend, modelId: "m1", startedAt, endedAt: startedAt + latencyMs, latencyMs, status: "succeeded", inputTokens: 1000, outputTokens: 500,
});
const step = (name: string, attempt: number, startedAt: number, latencyMs: number, extra: Partial<StepRecord> = {}): StepRecord => ({
  runId: "r1", step: name, attempt, status: "succeeded", startedAt, endedAt: startedAt + latencyMs, latencyMs,
  inputTokens: 1000, outputTokens: 500, costUsd: 0.01, modelId: "m1", artifactRefs: { a: "k" }, ...extra,
});

describe("buildRunMetrics", () => {
  const steps = [
    step("ingest", 1, 1000, 2000, { inputTokens: 0, outputTokens: 0, costUsd: undefined, modelId: undefined }),
    step("extract", 1, 5000, 4000, { calls: [call(1, 5100, 3800, "agentcore")] }),
    step("fill_logic", 1, 10000, 6000, { costUsd: 0.03, inputTokens: 3000, outputTokens: 1000, calls: [call(1, 10100, 2000), call(2, 12200, 3700)] }),
  ];
  const m = buildRunMetrics(run, steps);

  it("accumulates time and cost across steps", () => {
    expect(m.steps.map((s) => s.cumulative.elapsedMs)).toEqual([2000, 8000, 15000]);
    expect(m.steps.map((s) => s.cumulative.modelCostUsd)).toEqual([0, 0.01, 0.04]);
    expect(m.totals.wallClockMs).toBe(15000);
    expect(m.totals.activeMs).toBe(12000);
    expect(m.totals.waitMs).toBe(3000);
    expect(m.steps[1]!.waitBeforeMs).toBe(2000);
  });

  it("charges AgentCore only for agentcore calls", () => {
    expect(m.steps[1]!.aws.agentcoreUsd).toBeGreaterThan(0);
    expect(m.steps[2]!.aws.agentcoreUsd).toBe(0);
  });

  it("splits a step's cost over its calls by tokens", () => {
    const calls = m.steps[2]!.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.modelCostUsd! + calls[1]!.modelCostUsd!).toBeCloseTo(0.03 * 3000 / 4000, 9);
  });

  it("reports unknown (not zero) when a step has tokens but no price", () => {
    const x = buildRunMetrics(run, [step("extract", 1, 0, 100, { costUsd: undefined })]);
    expect(x.totals.modelCostUsd).toBeNull();
    expect(x.totals.totalUsd).toBeNull();
    expect(x.totals.unpricedSteps).toEqual(["extract"]);
  });

  it("handles a run with no steps", () => {
    const x = buildRunMetrics(run, []);
    expect(x.totals.totalUsd).toBe(0);
    expect(x.steps).toEqual([]);
  });

  it("renders text, csv and html", () => {
    expect(renderText(m)).toContain("fill_logic");
    expect(renderCsv(m).split("\n")[0]).toContain("latencyMs");
    expect(renderHtml(m)).toContain("<table");
  });
});

describe("instrumentModel", () => {
  const schema = z.object({ a: z.number() });
  const req = { modelId: "m1", system: "s", content: [], schema, maxTokens: 10 };

  it("records a succeeded call without storing content", async () => {
    let t = 0;
    const sink: CallRecord[] = [];
    const model = instrumentModel(new FakeModelClient([{ raw: '{"a":1}', usage: { inputTokens: 7, outputTokens: 3, modelId: "m1" } }]), { now: () => (t += 10), backend: "bedrock", sink });
    await model.generateJson(req);
    expect(sink).toEqual([{ seq: 1, backend: "bedrock", modelId: "m1", startedAt: 10, endedAt: 20, latencyMs: 10, status: "succeeded", inputTokens: 7, outputTokens: 3 }]);
  });

  it("records a failed call, keeps the usage of a bad output, and rethrows", async () => {
    const sink: CallRecord[] = [];
    const model = instrumentModel(new FakeModelClient([{ raw: "not json", usage: { inputTokens: 5, outputTokens: 2, modelId: "m1" } }]), { now: () => 0, backend: "agentcore", sink });
    await expect(model.generateJson(req)).rejects.toThrow();
    expect(sink[0]).toMatchObject({ status: "failed", inputTokens: 5, outputTokens: 2, backend: "agentcore" });
  });
});
