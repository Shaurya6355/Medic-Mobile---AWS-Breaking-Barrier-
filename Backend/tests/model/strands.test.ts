import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TransientError } from "../../src/engine/step.js";

type Invoke = (content: unknown, options?: { cancelSignal?: AbortSignal }) => Promise<unknown>;
const state: { invoke: Invoke; seenOptions: unknown[] } = { invoke: async () => ({}), seenOptions: [] };

vi.mock("@strands-agents/sdk", () => ({
  BedrockModel: class {},
  TextBlock: class {
    constructor(public text: string) {}
  },
  ImageBlock: class {
    constructor(public o: unknown) {}
  },
  Agent: class {
    invoke(content: unknown, options?: { cancelSignal?: AbortSignal }) {
      state.seenOptions.push(options);
      return state.invoke(content, options);
    }
  },
}));

const { DEFAULT_BEDROCK_TIMEOUT_MS, createStrandsModelClient, temperatureSetting } = await import("../../src/model/strands.js");

const req = { modelId: "m", system: "s", maxTokens: 10, schema: z.object({ a: z.number() }), content: [{ type: "text" as const, text: "hi" }] };
const result = (raw: string, stopReason = "endTurn") => ({
  stopReason,
  toString: () => raw,
  metrics: { accumulatedUsage: { inputTokens: 3, outputTokens: 4 } },
});

beforeEach(() => {
  state.seenOptions = [];
});

describe("createStrandsModelClient timeout", () => {
  it("defaults to 6 minutes", () => {
    expect(DEFAULT_BEDROCK_TIMEOUT_MS).toBe(6 * 60 * 1000);
  });
  it("passes a cancelSignal to the agent and returns the result", async () => {
    state.invoke = async () => result('{"a":1}');
    const r = await createStrandsModelClient({ region: "us-west-2" }).generateJson(req);
    expect(r.value).toEqual({ a: 1 });
    const opts = state.seenOptions[0] as { cancelSignal?: AbortSignal };
    expect(opts.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(opts.cancelSignal?.aborted).toBe(false);
  });
  it("aborts the signal and throws TransientError when the SDK stops with 'cancelled'", async () => {
    state.invoke = (_c, o) =>
      new Promise((resolve) => o?.cancelSignal?.addEventListener("abort", () => resolve(result("", "cancelled"))));
    const p = createStrandsModelClient({ region: "us-west-2", timeoutMs: 20 }).generateJson(req);
    await expect(p).rejects.toBeInstanceOf(TransientError);
    await expect(p).rejects.toThrow(/timed out/);
  });
  it("still times out when the SDK ignores the signal (non-cancelling race)", async () => {
    state.invoke = () => new Promise(() => {});
    await expect(createStrandsModelClient({ region: "us-west-2", timeoutMs: 20 }).generateJson(req)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("temperatureSetting", () => {
  it("sends no temperature to Claude Haiku 5.5, which rejects it, and 0 to every other model", () => {
    expect(temperatureSetting("us.anthropic.claude-haiku-5-5")).toEqual({});
    expect(temperatureSetting("us.meta.llama4-scout-17b-instruct-v1:0")).toEqual({ temperature: 0 });
    expect(temperatureSetting("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({ temperature: 0 });
  });
});
