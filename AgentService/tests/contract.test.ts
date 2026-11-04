import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BLOCKS, invocationRequestSchema, invocationResponseSchema } from "../src/contract.js";

const base = { modelId: "m", system: "s", maxTokens: 100, content: [{ type: "text", text: "hi" }] };

describe("invocationRequestSchema", () => {
  it("accepts text and image content", () => {
    const r = invocationRequestSchema.safeParse({
      ...base,
      content: [{ type: "text", text: "a" }, { type: "image", format: "png", base64: "AAAA" }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects empty content, too many blocks, bad maxTokens, bad type/format", () => {
    expect(invocationRequestSchema.safeParse({ ...base, content: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_CONTENT_BLOCKS + 1 }, () => ({ type: "text", text: "x" }));
    expect(invocationRequestSchema.safeParse({ ...base, content: many }).success).toBe(false);
    expect(invocationRequestSchema.safeParse({ ...base, maxTokens: 0 }).success).toBe(false);
    expect(invocationRequestSchema.safeParse({ ...base, maxTokens: 64001 }).success).toBe(false);
    expect(invocationRequestSchema.safeParse({ ...base, maxTokens: 1.5 }).success).toBe(false);
    expect(invocationRequestSchema.safeParse({ ...base, content: [{ type: "audio" }] }).success).toBe(false);
    expect(
      invocationRequestSchema.safeParse({ ...base, content: [{ type: "image", format: "jpeg", base64: "AAAA" }] }).success,
    ).toBe(false);
  });
  it("rejects oversized system and empty modelId", () => {
    expect(invocationRequestSchema.safeParse({ ...base, system: "x".repeat(200_001) }).success).toBe(false);
    expect(invocationRequestSchema.safeParse({ ...base, system: "x".repeat(200_000) }).success).toBe(true);
    expect(invocationRequestSchema.safeParse({ ...base, modelId: "" }).success).toBe(false);
  });
  it("allows 3 blocks per page plus 2 for the default 200 pages", () => {
    expect(MAX_CONTENT_BLOCKS).toBe(700);
    const full = Array.from({ length: 602 }, () => ({ type: "text", text: "x" }));
    expect(invocationRequestSchema.safeParse({ ...base, content: full }).success).toBe(true);
  });
});

describe("invocationResponseSchema", () => {
  it("accepts the ok and failure envelopes", () => {
    expect(invocationResponseSchema.safeParse({ ok: true, raw: "r", usage: { inputTokens: 1, outputTokens: 2, modelId: "m" } }).success).toBe(true);
    for (const kind of ["transient", "permanent", "invalid_request"]) {
      expect(invocationResponseSchema.safeParse({ ok: false, kind, message: "m" }).success).toBe(true);
    }
  });
  it("rejects unknown kinds and a missing ok", () => {
    expect(invocationResponseSchema.safeParse({ ok: false, kind: "weird", message: "m" }).success).toBe(false);
    expect(invocationResponseSchema.safeParse({ raw: "r", usage: { inputTokens: 1, outputTokens: 2, modelId: "m" } }).success).toBe(false);
  });
});
