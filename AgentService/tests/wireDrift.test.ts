// Drift guard between this service and the Backend's AgentCore client. It imports the Backend
// sources by relative path, so the Backend dependencies must be installed too (`npm ci` in Backend).
import { describe, expect, it } from "vitest";
import { toWireContent } from "../../Backend/src/model/agentcore.js";
import {
  WIRE_MAX_BLOCKS,
  WIRE_MAX_BODY_BYTES,
  WIRE_MAX_FAILURE_MESSAGE,
  wireRequestSchema,
  wireResponseSchema,
} from "../../Backend/src/model/agentcoreWire.js";
import type { ModelContent } from "../../Backend/src/model/modelClient.js";
import type { AgentFactory } from "../src/agent.js";
import { MAX_BODY_BYTES, MAX_CONTENT_BLOCKS, MAX_FAILURE_MESSAGE, invocationRequestSchema, invocationResponseSchema } from "../src/contract.js";
import { DEFAULT_BODY_LIMIT_BYTES, buildServer } from "../src/server.js";

const MAX_PAGES = 200;

// Same shape as Backend/src/steps/extract.ts: a header, then label + image + blocks per page, then a closing line.
function extractContent(pages: number, imageBytes: number): ModelContent[] {
  const content: ModelContent[] = [{ type: "text", text: "header" }];
  const png = new Uint8Array(imageBytes).fill(7);
  for (let p = 1; p <= pages; p++) {
    content.push({ type: "text", text: `--- pdf_page ${p} ---` });
    content.push({ type: "image", format: "png", bytes: png });
    content.push({ type: "text", text: "Blocks: []" });
  }
  content.push({ type: "text", text: "Return one JSON object for the whole document." });
  return content;
}

const wireBody = (content: ModelContent[]) => ({ modelId: "m", system: "s", maxTokens: 32000, content: toWireContent(content) });

describe("limits are identical", () => {
  it("matches the Backend constants", () => {
    expect(MAX_CONTENT_BLOCKS).toBe(WIRE_MAX_BLOCKS);
    expect(MAX_BODY_BYTES).toBe(WIRE_MAX_BODY_BYTES);
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(WIRE_MAX_BODY_BYTES);
    expect(MAX_FAILURE_MESSAGE).toBe(WIRE_MAX_FAILURE_MESSAGE);
  });
  it("covers 3 blocks per page plus 2 for MAX_PAGES", () => {
    expect(3 * MAX_PAGES + 2).toBeLessThanOrEqual(MAX_CONTENT_BLOCKS);
  });
});

describe("a full-size request built with the Backend serializer", () => {
  it("is accepted by the AgentService schema and fits the body limit", () => {
    const body = wireBody(extractContent(MAX_PAGES, 250_000));
    expect(body.content).toHaveLength(3 * MAX_PAGES + 2);
    expect(wireRequestSchema.safeParse(body).success).toBe(true);
    const parsed = invocationRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(DEFAULT_BODY_LIMIT_BYTES);
  });
  it("is rejected by both schemas just past the block limit", () => {
    const body = wireBody(extractContent(MAX_PAGES, 1));
    body.content.push(...Array.from({ length: MAX_CONTENT_BLOCKS }, () => ({ type: "text" as const, text: "x" })));
    expect(wireRequestSchema.safeParse(body).success).toBe(false);
    expect(invocationRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("the AgentService response envelope parses with the Backend response schema", () => {
  const body = wireBody([{ type: "text", text: "hi" }]);
  const ok: AgentFactory = () => ({
    async invoke() {
      return { toString: () => "out", metrics: { accumulatedUsage: { inputTokens: 1, outputTokens: 2 } } } as never;
    },
  });
  const failing: AgentFactory = () => ({
    async invoke() {
      throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    },
  });

  it("ok: true", async () => {
    const res = await buildServer({ createAgent: ok }).inject({ method: "POST", url: "/invocations", payload: body });
    expect(invocationResponseSchema.safeParse(res.json()).success).toBe(true);
    const r = wireResponseSchema.safeParse(res.json());
    expect(r.success && r.data.ok).toBe(true);
  });
  it("ok: false (each failure path)", async () => {
    const t = await buildServer({ createAgent: failing }).inject({ method: "POST", url: "/invocations", payload: body });
    const bad = await buildServer({ createAgent: ok }).inject({ method: "POST", url: "/invocations", payload: { ...body, maxTokens: 0 } });
    for (const [res, kind] of [[t, "transient"], [bad, "invalid_request"]] as const) {
      expect(invocationResponseSchema.safeParse(res.json()).success).toBe(true);
      const r = wireResponseSchema.safeParse(res.json());
      expect(r.success && !r.data.ok && r.data.kind).toBe(kind);
    }
  });
});
