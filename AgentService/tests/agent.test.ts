import { describe, expect, it } from "vitest";
import { BadRequestError, isTransientBedrockError, runAgent, type AgentFactory } from "../src/agent.js";
import type { InvocationRequest } from "../src/contract.js";

const req: InvocationRequest = {
  modelId: "model-x",
  system: "sys",
  maxTokens: 50,
  content: [{ type: "text", text: "hello" }, { type: "image", format: "png", base64: "iVBORw0=" }],
};

function fake(result: unknown, seen?: { opts?: unknown; content?: unknown }): AgentFactory {
  return (opts) => {
    if (seen) seen.opts = opts;
    return {
      async invoke(content) {
        if (seen) seen.content = content;
        if (result instanceof Error) throw result;
        return result as never;
      },
    };
  };
}

describe("runAgent", () => {
  it("maps the agent result to {raw, usage}", async () => {
    const seen: { opts?: unknown; content?: unknown } = {};
    const out = await runAgent(
      req,
      { createAgent: fake({ toString: () => "RAW", metrics: { accumulatedUsage: { inputTokens: 3, outputTokens: 4 } } }, seen), region: "eu-west-1" },
    );
    expect(out).toEqual({ ok: true, raw: "RAW", usage: { inputTokens: 3, outputTokens: 4, modelId: "model-x" } });
    expect(seen.opts).toEqual({ region: "eu-west-1", modelId: "model-x", maxTokens: 50, system: "sys" });
    expect((seen.content as unknown[]).length).toBe(2);
  });
  it("defaults usage to 0 and region to us-west-2", async () => {
    const seen: { opts?: unknown } = {};
    const out = await runAgent(req, { createAgent: fake({ toString: () => "R" }, seen) });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, modelId: "model-x" });
    expect((seen.opts as { region: string }).region).toBe("us-west-2");
  });
  it("rejects invalid base64 with BadRequestError before calling the agent", async () => {
    let called = false;
    const deps = { createAgent: ((): never => { called = true; throw new Error("no"); }) as AgentFactory };
    for (const b of ["not base64!!", "abc", ""]) {
      await expect(
        runAgent({ ...req, content: [{ type: "image", format: "png", base64: b }] }, deps),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
    expect(called).toBe(false);
  });
  it("propagates agent errors", async () => {
    await expect(runAgent(req, { createAgent: fake(new Error("boom")) })).rejects.toThrow("boom");
  });
});

describe("isTransientBedrockError", () => {
  it("detects names, codes, statuses and causes", () => {
    expect(isTransientBedrockError(Object.assign(new Error("x"), { name: "ThrottlingException" }))).toBe(true);
    expect(isTransientBedrockError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientBedrockError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isTransientBedrockError({ cause: { statusCode: 429 } })).toBe(true);
    expect(isTransientBedrockError(new Error("plain"))).toBe(false);
    expect(isTransientBedrockError({ status: 400 })).toBe(false);
    expect(isTransientBedrockError(null)).toBe(false);
  });
  it("treats stream and not-ready model errors, including wrapped ones, as transient", () => {
    for (const name of ["ModelStreamErrorException", "ModelNotReadyException"]) {
      const e = Object.assign(new Error("x"), { name });
      expect(isTransientBedrockError(e)).toBe(true);
      expect(isTransientBedrockError(new Error("wrapped", { cause: e }))).toBe(true);
    }
  });
});
