import { z } from "zod";

export const textBlockSchema = z.object({ type: z.literal("text"), text: z.string().max(5_000_000) });
export const imageBlockSchema = z.object({
  type: z.literal("image"),
  format: z.literal("png"),
  base64: z.string().min(1).max(40_000_000),
});

// Limits derive from the page limit. The Backend extract step sends 3 blocks per page (a label,
// the image, the blocks text) plus 2 (header and closing instruction); MAX_PAGES defaults to 200,
// so 3 * 200 + 2 = 602, rounded up to 700. Keep Backend/src/model/agentcoreWire.ts identical
// (AgentService/tests/wireDrift.test.ts fails if they drift).
export const MAX_CONTENT_BLOCKS = 700;
// AgentCore caps the payload at 100 MB; stay below it. Also the service's default body limit.
export const MAX_BODY_BYTES = 90 * 1024 * 1024;

export const invocationRequestSchema = z.object({
  modelId: z.string().min(1).max(256),
  system: z.string().max(200_000),
  maxTokens: z.number().int().min(1).max(64_000),
  content: z.array(z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema])).min(1).max(MAX_CONTENT_BLOCKS),
});
export type InvocationRequest = z.infer<typeof invocationRequestSchema>;

export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  modelId: z.string(),
});
export const MAX_FAILURE_MESSAGE = 300;

export const FAILURE_KINDS = ["transient", "permanent", "invalid_request"] as const;

// The service always answers HTTP 200 with this envelope: AgentCore wraps a container 4xx/5xx
// into an opaque RuntimeClientError (HTTP 424), so status codes cannot carry the classification.
export const invocationResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), raw: z.string(), usage: usageSchema }),
  z.object({ ok: z.literal(false), kind: z.enum(FAILURE_KINDS), message: z.string().max(MAX_FAILURE_MESSAGE) }),
]);
export type InvocationResponse = z.infer<typeof invocationResponseSchema>;
export type InvocationSuccess = Extract<InvocationResponse, { ok: true }>;
export type InvocationFailure = Extract<InvocationResponse, { ok: false }>;

export const pingResponseSchema = z.object({
  status: z.enum(["Healthy", "HealthyBusy"]),
  time_of_last_update: z.number().int().optional(),
});
export type PingResponse = z.infer<typeof pingResponseSchema>;
