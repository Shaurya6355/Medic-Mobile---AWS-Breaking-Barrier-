import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { cleanFields, createLogger, NAMESPACE } from "../../src/observability/logger.js";
import { observeModel, observeStore } from "../../src/observability/observe.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { Conflict } from "../../src/store/store.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { z } from "zod";

const capture = () => {
  const lines: Record<string, any>[] = [];
  const log = createLogger({ write: (l) => lines.push(JSON.parse(l)), now: () => 1_700_000_000_000, minLevel: "debug", base: { service: "t" } });
  return { lines, log };
};

describe("logger", () => {
  it("writes one JSON line with level, message and base fields", () => {
    const { lines, log } = capture();
    log.info("hello", { runId: "r1", n: 2 });
    expect(lines[0]).toMatchObject({ level: "info", msg: "hello", service: "t", runId: "r1", n: 2, at: "2023-11-14T22:13:20.000Z" });
  });

  it("never logs content: bodies, text, comments, secrets; keeps ids, counts and token fields", () => {
    expect(cleanFields({ body: "x", text: "x", comment: "x", resolution: "x", sessionToken: "x", secretKey: "x", context: "ok", inputTokens: 5, runId: "r", list: [1, 2, 3], nested: { a: 1 } })).toEqual({
      context: "ok",
      inputTokens: 5,
      runId: "r",
      listCount: 3,
    });
  });

  it("truncates long strings", () => {
    const out = cleanFields({ error: "e".repeat(1000) });
    expect((out["error"] as string).length).toBeLessThan(400);
  });

  it("emits a CloudWatch Embedded Metric Format line", () => {
    const { lines, log } = capture();
    log.metric("StepDurationMs", 120, "Milliseconds", { Step: "extract" }, { runId: "r1" });
    const l = lines[0]!;
    expect(l["StepDurationMs"]).toBe(120);
    expect(l["Step"]).toBe("extract");
    expect(l["_aws"].CloudWatchMetrics[0]).toEqual({ Namespace: NAMESPACE, Dimensions: [["Step"], []], Metrics: [{ Name: "StepDurationMs", Unit: "Milliseconds" }] });
    expect(l["_aws"].Timestamp).toBe(1_700_000_000_000);
  });

  it("metrics ignore the log level, and bad values are skipped", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), minLevel: "error" });
    log.info("hidden");
    log.metric("X", 1);
    log.metric("Y", Number.NaN);
    expect(lines).toHaveLength(1);
  });

  it("child loggers add fields", () => {
    const { lines, log } = capture();
    log.child({ runId: "r9" }).info("m");
    expect(lines[0]).toMatchObject({ runId: "r9", service: "t" });
  });
});

describe("observeStore", () => {
  const rec = { runId: "r1", step: "extract", attempt: 1, status: "running" as const, startedAt: 1, inputTokens: 0, outputTokens: 0, artifactRefs: {} };

  it("logs step start, success and failure with metrics, and still stores them", async () => {
    const { lines, log } = capture();
    const inner = new MemoryStore();
    const store = observeStore(inner, log);
    await store.createRun({ runId: "r1", state: "created", createdAt: 1 });
    await store.appendStep(rec);
    await store.updateStep("r1", "extract", 1, { status: "succeeded", latencyMs: 250, inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
    await store.appendStep({ ...rec, step: "fill_logic" });
    await store.updateStep("r1", "fill_logic", 1, { status: "failed", error: "boom" });

    expect(lines.filter((l) => l["msg"] === "step.started").map((l) => l["step"])).toEqual(["extract", "fill_logic"]);
    expect(lines.find((l) => l["msg"] === "step.succeeded")).toMatchObject({ runId: "r1", step: "extract", latencyMs: 250, inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
    expect(lines.find((l) => l["msg"] === "step.failed")).toMatchObject({ level: "error", step: "fill_logic", error: "boom" });
    expect(lines.find((l) => l["StepDurationMs"] === 250)).toMatchObject({ Step: "extract" });
    expect(lines.some((l) => l["StepFailed"] === 1 && l["Step"] === "fill_logic")).toBe(true);
    // The underlying store has the data.
    expect((await inner.listSteps("r1")).map((s) => s.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("logs run state changes and audit events (detail reduced to safe fields)", async () => {
    const { lines, log } = capture();
    const store = observeStore(new MemoryStore(), log);
    await store.createRun({ runId: "r1", state: "created", createdAt: 1 });
    await store.updateRun("r1", { state: "extracting" });
    await store.appendAudit("r1", { at: 1, type: "run_state", detail: { from: "created", to: "extracting", filename: "secret-patient.pdf", comment: "private" } });
    expect(lines.find((l) => l["msg"] === "run.state")).toMatchObject({ runId: "r1", state: "extracting" });
    await store.updateRun("r1", { state: "failed", currentStep: "extract" });
    expect(lines.find((l) => l["msg"] === "run.failed")).toMatchObject({ level: "error", runId: "r1", currentStep: "extract" });
    expect(lines.some((l) => l["RunState"] === 1 && l["State"] === "failed")).toBe(true);
    const audit = lines.find((l) => l["msg"] === "audit")!;
    expect(audit).toMatchObject({ runId: "r1", type: "run_state", from: "created", to: "extracting" });
    expect(JSON.stringify(lines)).not.toContain("secret-patient");
    expect(JSON.stringify(lines)).not.toContain("private");
  });

  it("rethrows errors unchanged; conflicts are debug, other faults are error + StoreError metric", async () => {
    const { lines, log } = capture();
    const store = observeStore(new MemoryStore(), log);
    await store.createRun({ runId: "r1", state: "created", createdAt: 1 });
    await expect(store.updateRun("r1", { state: "extracting" }, "failed")).rejects.toBeInstanceOf(Conflict);
    expect(lines.some((l) => l["msg"] === "store.conflict" && l["level"] === "debug")).toBe(true);
    await expect(store.updateRun("missing", { state: "failed" })).rejects.toThrow();
    expect(lines.some((l) => l["msg"] === "store.error" && l["level"] === "error")).toBe(true);
    expect(lines.some((l) => l["StoreError"] === 1)).toBe(true);
  });

  it("passes reads through", async () => {
    const { log } = capture();
    const store = observeStore(new MemoryStore(), log);
    await store.createRun({ runId: "r1", state: "created", createdAt: 1 });
    expect((await store.getRun("r1"))?.runId).toBe("r1");
    expect(await store.listRuns()).toHaveLength(1);
  });
});

describe("observeModel", () => {
  const req = { modelId: "m1", system: "s", content: [{ type: "text" as const, text: "SECRET PROMPT" }], schema: z.object({ a: z.number() }), maxTokens: 100 };

  it("logs latency and tokens, never the prompt", async () => {
    const { lines, log } = capture();
    const model = observeModel(new FakeModelClient([{ raw: '{"a":1}', usage: { inputTokens: 7, outputTokens: 3, modelId: "m1" } }]), log, "revision");
    const out = await model.generateJson(req);
    expect(out.value).toEqual({ a: 1 });
    expect(lines.find((l) => l["msg"] === "model.call")).toMatchObject({ label: "revision", modelId: "m1", inputTokens: 7, outputTokens: 3 });
    expect(lines.some((l) => l["ModelInputTokens"] === 7 && l["ModelId"] === "m1")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("SECRET PROMPT");
  });

  it("logs and counts a failure, then rethrows", async () => {
    const { lines, log } = capture();
    const model = observeModel(new FakeModelClient([new Error("throttled")]), log);
    await expect(model.generateJson(req)).rejects.toThrow("throttled");
    expect(lines.find((l) => l["msg"] === "model.error")).toMatchObject({ level: "error", error: "throttled" });
    expect(lines.some((l) => l["ModelError"] === 1)).toBe(true);
  });
});

describe("observeModel invalid output", () => {
  const req = { modelId: "m1", system: "s", content: [{ type: "text" as const, text: "SECRET PROMPT" }], schema: z.object({ a: z.number() }), maxTokens: 100 };
  it("is a warning with its own metric and logs only the shape, not the text", async () => {
    const { lines, log } = capture();
    const model = observeModel(new FakeModelClient([{ raw: "I cannot help with SECRET-ANSWER. ```json\nnope\n```" }]), log);
    await expect(model.generateJson(req)).rejects.toThrow();
    const w = lines.find((l) => l["msg"] === "model.invalid_output")!;
    expect(w).toMatchObject({ level: "warn", fences: 1, startsJson: false });
    expect(lines.some((l) => l["ModelOutputInvalid"] === 1)).toBe(true);
    expect(lines.some((l) => l["ModelError"] !== undefined)).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("SECRET-ANSWER");
  });
});

describe("HTTP request logging", () => {
  it("logs route, status and duration, counts 4xx, and skips /ping", async () => {
    const { lines, log } = capture();
    const store = new MemoryStore();
    const app = buildServer({
      orchestrator: { createRun: undefined as never, resume: async () => {}, prepareResume: async () => {}, onUploaded: async () => {}, resumeAll: async () => {}, activeCount: () => 0, lastStatusChange: () => 0 } as never,
      store, artifacts: new MemoryArtifactStore(), validator: parseModelValidator, presign: async (k: string) => k, onVersionSaved: async () => {}, maxPages: 10, observe: log,
    });
    await app.inject({ method: "GET", url: "/ping" });
    await app.inject({ method: "GET", url: "/runs/does-not-exist" });
    const req = lines.find((l) => l["msg"] === "http.request")!;
    expect(req).toMatchObject({ method: "GET", route: "/runs/:id", status: 404, level: "warn" });
    expect(typeof req["durationMs"]).toBe("number");
    expect(lines.filter((l) => l["msg"] === "http.request")).toHaveLength(1);
    expect(lines.some((l) => l["Http4xx"] === 1)).toBe(true);
  });
});

describe("unhandled errors", () => {
  it("logs the cause of a 500", async () => {
    const { lines, log } = capture();
    const app = buildServer({
      orchestrator: { createRun: async () => { throw new Error("db down"); }, resume: async () => {}, prepareResume: async () => {}, onUploaded: async () => {}, resumeAll: async () => {}, activeCount: () => 0, lastStatusChange: () => 0 } as never,
      store: new MemoryStore(), artifacts: new MemoryArtifactStore(), validator: parseModelValidator, presign: async (k: string) => k, onVersionSaved: async () => {}, maxPages: 10, observe: log,
    });
    const res = await app.inject({ method: "POST", url: "/runs", payload: { filename: "a.pdf" } });
    expect(res.statusCode).toBe(500);
    expect(lines.find((l) => l["msg"] === "http.unhandled")).toMatchObject({ level: "error", route: "/runs", errName: "Error", error: "db down" });
    expect(lines.some((l) => l["Http5xx"] === 1)).toBe(true);
  });
});
