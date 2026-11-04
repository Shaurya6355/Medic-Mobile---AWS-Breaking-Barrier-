import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadConfig } from "../src/config.js";

const base = {
  TABLE_RUNS: "r", TABLE_STEPS: "s", TABLE_VERSIONS: "v", TABLE_COMMENTS: "c", TABLE_AUDIT: "a",
  ARTIFACT_BUCKET: "bk", UPLOAD_QUEUE_URL: "http://q", MODEL_ID: "us.m",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      region: "us-west-2", port: 8080, host: "0.0.0.0", leaseMs: 900000, maxPages: 200,
      sqsConcurrency: 4, shutdownTimeoutMs: 25000, pythonBin: "python3", modelId: "us.m", artifactBucket: "bk", uploadQueueUrl: "http://q",
      tables: { runs: "r", steps: "s", versions: "v", comments: "c", audit: "a" },
    });
    expect(c.prices).toEqual({});
    expect(path.basename(c.ingestScript)).toBe("prepare_input.py");
    expect(path.basename(path.dirname(c.ingestScript))).toBe("extraction");
    expect(path.basename(c.extractPrompt)).toBe("final_prompt.txt");
    expect(path.basename(c.fillPrompt)).toBe("fill_prompt.txt");
    expect(path.basename(path.dirname(c.fillPrompt))).toBe("extraction");
    expect(c.fillModelId).toBe("us.m");
  });
  it("reads chat settings with defaults", () => {
    expect(loadConfig(base)).toMatchObject({ chatModelId: "us.m", chatMaxCostUsd: 1, chatRatePerMin: 10 });
    expect(loadConfig({ ...base, CHAT_MODEL_ID: "us.c", CHAT_MAX_COST_USD: "0.5", CHAT_RATE_PER_MIN: "3" })).toMatchObject({ chatModelId: "us.c", chatMaxCostUsd: 0.5, chatRatePerMin: 3 });
    expect(() => loadConfig({ ...base, CHAT_MAX_COST_USD: "-1" })).toThrow(/CHAT_MAX_COST_USD/);
  });
  it("reads officer agent and chat token settings with defaults", () => {
    expect(loadConfig(base)).toMatchObject({ officerAgentModelId: "us.m", officerAgentMaxCostUsd: 2, chatMaxTokens: 200000 });
    expect(loadConfig({ ...base, OFFICER_AGENT_MODEL_ID: "us.a", OFFICER_AGENT_MAX_COST_USD: "0.5", CHAT_MAX_TOKENS: "5000" })).toMatchObject({ officerAgentModelId: "us.a", officerAgentMaxCostUsd: 0.5, chatMaxTokens: 5000 });
    expect(() => loadConfig({ ...base, OFFICER_AGENT_MAX_COST_USD: "0" })).toThrow(/OFFICER_AGENT_MAX_COST_USD/);
  });
  it("reads FILL_PROMPT and FILL_MODEL_ID", () => {
    const c = loadConfig({ ...base, FILL_PROMPT: "/f.txt", FILL_MODEL_ID: "us.small" });
    expect(c).toMatchObject({ fillPrompt: "/f.txt", fillModelId: "us.small", modelId: "us.m" });
  });
  it("reads overrides", () => {
    const c = loadConfig({ ...base, AWS_REGION: "eu-west-1", PORT: "9000", HOST: "127.0.0.1", LEASE_MS: "5000", MAX_PAGES: "10", SQS_CONCURRENCY: "2", SHUTDOWN_TIMEOUT_MS: "3000", PYTHON_BIN: "py", INGEST_SCRIPT: "/x.py", EXTRACT_PROMPT: "/p.txt", PRICES_JSON: '{"us.m":{"inPerMTok":1,"outPerMTok":2}}' });
    expect(c).toMatchObject({ region: "eu-west-1", port: 9000, host: "127.0.0.1", leaseMs: 5000, maxPages: 10, sqsConcurrency: 2, shutdownTimeoutMs: 3000, pythonBin: "py", ingestScript: "/x.py", extractPrompt: "/p.txt" });
    expect(c.prices["us.m"]).toEqual({ inPerMTok: 1, outPerMTok: 2 });
  });
  it("MAX_PDF_BYTES defaults to 50 MiB and can be overridden", () => {
    expect(loadConfig(base).maxPdfBytes).toBe(52428800);
    expect(loadConfig({ ...base, MAX_PDF_BYTES: "1000" }).maxPdfBytes).toBe(1000);
    expect(() => loadConfig({ ...base, MAX_PDF_BYTES: "0" })).toThrow("MAX_PDF_BYTES");
    expect(() => loadConfig({ ...base, MAX_PDF_BYTES: "abc" })).toThrow("MAX_PDF_BYTES");
  });
  it("lists names of all missing variables, never values", () => {
    const { TABLE_RUNS, MODEL_ID, ...rest } = base;
    void TABLE_RUNS; void MODEL_ID;
    let msg = "";
    try { loadConfig({ ...rest, ARTIFACT_BUCKET: "" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("TABLE_RUNS");
    expect(msg).toContain("MODEL_ID");
    expect(msg).toContain("ARTIFACT_BUCKET");
    expect(msg).not.toContain("http://q");
  });
  it.each([["LEASE_MS", "0"], ["LEASE_MS", "abc"], ["LEASE_MS", "1.5"], ["LEASE_MS", "-3"], ["PORT", "x"], ["MAX_PAGES", "0"], ["SQS_CONCURRENCY", "0"], ["PORT", "70000"], ["SHUTDOWN_TIMEOUT_MS", "0"], ["SHUTDOWN_TIMEOUT_MS", "2.5"], ["SHUTDOWN_TIMEOUT_MS", "x"]])(
    "rejects %s=%s naming the variable",
    (name, value) => {
      expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
    },
  );
  it("propagates invalid PRICES_JSON", () => {
    expect(() => loadConfig({ ...base, PRICES_JSON: "{" })).toThrow(/PRICES_JSON/);
  });
  it("defaults RUN_MODE to container and requires UPLOAD_QUEUE_URL there", () => {
    expect(loadConfig(base).runMode).toBe("container");
    expect(loadConfig({ ...base, RUN_MODE: "container" }).runMode).toBe("container");
    const { UPLOAD_QUEUE_URL, ...noQueue } = base;
    void UPLOAD_QUEUE_URL;
    expect(() => loadConfig(noQueue)).toThrow(/UPLOAD_QUEUE_URL/);
  });
  it("agentcore mode does not require UPLOAD_QUEUE_URL", () => {
    const { UPLOAD_QUEUE_URL, ...noQueue } = base;
    void UPLOAD_QUEUE_URL;
    const c = loadConfig({ ...noQueue, RUN_MODE: "agentcore" });
    expect(c.runMode).toBe("agentcore");
    expect(c.uploadQueueUrl).toBeUndefined();
  });
  it("agentcore mode still requires the other variables", () => {
    expect(() => loadConfig({ RUN_MODE: "agentcore" })).toThrow(/TABLE_RUNS/);
  });
  it("lambda mode does not require UPLOAD_QUEUE_URL", () => {
    const { UPLOAD_QUEUE_URL, ...noQueue } = base;
    void UPLOAD_QUEUE_URL;
    const c = loadConfig({ ...noQueue, RUN_MODE: "lambda" });
    expect(c.runMode).toBe("lambda");
    expect(c.uploadQueueUrl).toBeUndefined();
  });
  it("lambda mode still requires the other variables", () => {
    expect(() => loadConfig({ RUN_MODE: "lambda" })).toThrow(/TABLE_RUNS/);
  });
  it("lambda mode defaults LEASE_MS to 960000 and other modes keep 900000", () => {
    expect(loadConfig({ ...base, RUN_MODE: "lambda" }).leaseMs).toBe(960000);
    expect(loadConfig(base).leaseMs).toBe(900000);
    expect(loadConfig({ ...base, RUN_MODE: "lambda", LEASE_MS: "960001" }).leaseMs).toBe(960001);
  });
  it.each(["900000", "1000", "1"])("lambda mode rejects LEASE_MS=%s with a clear error", (v) => {
    expect(() => loadConfig({ ...base, RUN_MODE: "lambda", LEASE_MS: v })).toThrow(/LEASE_MS.*900000.*lambda/);
    expect(loadConfig({ ...base, LEASE_MS: v }).leaseMs).toBe(Number(v));
  });
  it.each(["AgentCore", "Lambda", "x"])("rejects RUN_MODE=%s with a clear error", (v) => {
    expect(() => loadConfig({ ...base, RUN_MODE: v })).toThrow(/RUN_MODE must be one of: container, agentcore, lambda/);
  });
  it("defaults MODEL_BACKEND to bedrock and needs no runtime ARN", () => {
    const c = loadConfig(base);
    expect(c.modelBackend).toBe("bedrock");
    expect(c.agentCoreRuntimeArn).toBeUndefined();
  });
  it("rejects an unknown MODEL_BACKEND naming the allowed values", () => {
    expect(() => loadConfig({ ...base, MODEL_BACKEND: "x" })).toThrow(/bedrock, agentcore/);
  });
  it("agentcore backend requires a bedrock-agentcore runtime ARN", () => {
    const arn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-abc";
    expect(() => loadConfig({ ...base, MODEL_BACKEND: "agentcore" })).toThrow(/AGENTCORE_RUNTIME_ARN/);
    expect(() => loadConfig({ ...base, MODEL_BACKEND: "agentcore", AGENTCORE_RUNTIME_ARN: "arn:aws:s3:::b" })).toThrow(/AGENTCORE_RUNTIME_ARN/);
    expect(() => loadConfig({ ...base, MODEL_BACKEND: "agentcore", AGENTCORE_RUNTIME_ARN: "nope" })).toThrow(/AGENTCORE_RUNTIME_ARN/);
    const c = loadConfig({ ...base, MODEL_BACKEND: "agentcore", AGENTCORE_RUNTIME_ARN: arn });
    expect(c).toMatchObject({ modelBackend: "agentcore", agentCoreRuntimeArn: arn });
  });
  it("ignores AGENTCORE_RUNTIME_ARN when the backend is bedrock", () => {
    expect(loadConfig({ ...base, AGENTCORE_RUNTIME_ARN: "junk" }).agentCoreRuntimeArn).toBeUndefined();
  });
});
