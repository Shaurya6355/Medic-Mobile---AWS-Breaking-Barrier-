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
  });
  it("reads overrides", () => {
    const c = loadConfig({ ...base, AWS_REGION: "eu-west-1", PORT: "9000", HOST: "127.0.0.1", LEASE_MS: "5000", MAX_PAGES: "10", SQS_CONCURRENCY: "2", SHUTDOWN_TIMEOUT_MS: "3000", PYTHON_BIN: "py", INGEST_SCRIPT: "/x.py", EXTRACT_PROMPT: "/p.txt", PRICES_JSON: '{"us.m":{"inPerMTok":1,"outPerMTok":2}}' });
    expect(c).toMatchObject({ region: "eu-west-1", port: 9000, host: "127.0.0.1", leaseMs: 5000, maxPages: 10, sqsConcurrency: 2, shutdownTimeoutMs: 3000, pythonBin: "py", ingestScript: "/x.py", extractPrompt: "/p.txt" });
    expect(c.prices["us.m"]).toEqual({ inPerMTok: 1, outPerMTok: 2 });
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
});
