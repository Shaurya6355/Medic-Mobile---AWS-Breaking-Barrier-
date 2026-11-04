import { z } from "zod";

// Wire contract with the AgentService (AgentService/src/contract.ts). The two files must
// match; change both together (AgentService/tests/wireDrift.test.ts fails if they drift).

// Limits derive from the page limit: extract sends 3 blocks per page (label, image, blocks text)
// plus 2 (header and closing instruction); MAX_PAGES defaults to 200, so 3 * 200 + 2 = 602,
// rounded up to 700. AgentCore caps a payload at 100 MB; stay below it.
export const WIRE_MAX_BLOCKS = 700;
export const WIRE_MAX_BODY_BYTES = 90 * 1024 * 1024;
export const WIRE_MAX_FAILURE_MESSAGE = 300;

export const wireTextBlockSchema = z.object({ type: z.literal("text"), text: z.string().max(5_000_000) });
export const wireImageBlockSchema = z.object({
  type: z.literal("image"),
  format: z.literal("png"),
  base64: z.string().min(1).max(40_000_000),
});

export const wireRequestSchema = z.object({
  modelId: z.string().min(1).max(256),
  system: z.string().max(200_000),
  maxTokens: z.number().int().min(1).max(64_000),
  content: z.array(z.discriminatedUnion("type", [wireTextBlockSchema, wireImageBlockSchema])).min(1).max(WIRE_MAX_BLOCKS),
});
export type WireRequest = z.infer<typeof wireRequestSchema>;

// AgentService always answers HTTP 200 with this envelope: AgentCore turns a container 4xx/5xx
// into an opaque RuntimeClientError (HTTP 424), so the classification travels in the body.
export const wireResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    raw: z.string(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), modelId: z.string() }),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(["transient", "permanent", "invalid_request"]),
    message: z.string().max(WIRE_MAX_FAILURE_MESSAGE),
  }),
]);
export type WireResponse = z.infer<typeof wireResponseSchema>;
