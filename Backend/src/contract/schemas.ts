import { z } from "zod";

export const RunState = z.enum([
  "created",
  "ingesting",
  "extracting",
  "filling_logic",
  "in_review",
  "checking",
  "failed",
]);
export type RunState = z.infer<typeof RunState>;

export const CreateRunRequest = z.object({
  pages: z
    .array(z.number().int().positive())
    .min(1, { message: "pages must not be empty; omit pages to use every page" })
    .refine((p) => new Set(p).size === p.length, { message: "pages must not contain duplicates" })
    .optional(),
  filename: z.string().min(1).max(255),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  runId: z.string(),
  uploadUrl: z.string(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const SaveVersionRequest = z.object({
  parentVersion: z.number().int().nonnegative(),
  body: z.unknown(),
  author: z.string().min(1).max(200),
});
export type SaveVersionRequest = z.infer<typeof SaveVersionRequest>;

export const CreateCommentRequest = z.object({
  itemRef: z.string().min(1).max(500),
  text: z.string().min(1).max(10000),
  author: z.string().min(1).max(200),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

// Amazon Bedrock AgentCore Runtime HTTP protocol: GET /ping and POST /invocations.
export const PingResponse = z.object({
  status: z.enum(["Healthy", "HealthyBusy"]),
  time_of_last_update: z.number().int().nonnegative().optional(),
});
export type PingResponse = z.infer<typeof PingResponse>;

export const INVOCATION_MAX_BODY_BYTES = 1024 * 1024;

export const InvocationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("uploaded"), runId: z.string().regex(/^[A-Za-z0-9-]+$/).max(128) }),
  z.object({ action: z.literal("resume_all") }),
  z.object({
    action: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(2048).startsWith("/"),
    headers: z
      .record(z.string().max(256), z.string().max(8192))
      .refine((h) => Object.keys(h).length <= 20, { message: "at most 20 headers" })
      .optional(),
    body: z.string().max(INVOCATION_MAX_BODY_BYTES).optional(),
  }),
]);
export type InvocationRequest = z.infer<typeof InvocationRequest>;

export const InvocationResponse = z.union([
  z.object({ accepted: z.literal(true) }),
  z.object({ statusCode: z.number().int(), headers: z.record(z.string(), z.string()), body: z.string() }),
]);
export type InvocationResponse = z.infer<typeof InvocationResponse>;

// Lambda Web Adapter pass-through: non-HTTP events (SQS, EventBridge schedule) arrive as POST /events.
export const LAMBDA_MAX_SQS_RECORDS = 100;

export const LambdaSqsRecord = z
  .object({ messageId: z.string().min(1).max(256), body: z.string().max(1024 * 1024) })
  .passthrough();
export type LambdaSqsRecord = z.infer<typeof LambdaSqsRecord>;

// Top level only: each record is validated on its own so one bad record cannot reject a batch.
export const LambdaSqsEnvelope = z.object({ Records: z.array(z.unknown()).min(1).max(LAMBDA_MAX_SQS_RECORDS) });
export type LambdaSqsEnvelope = z.infer<typeof LambdaSqsEnvelope>;

export const LambdaSqsEvent = z.object({ Records: z.array(LambdaSqsRecord).min(1).max(LAMBDA_MAX_SQS_RECORDS) });
export type LambdaSqsEvent = z.infer<typeof LambdaSqsEvent>;

export const LambdaScheduledEvent = z
  .object({ source: z.string().optional(), "detail-type": z.string().optional() })
  .passthrough()
  .refine((e) => e.source === "aws.events" || e["detail-type"] === "Scheduled Event", {
    message: "not a scheduled event",
  });
export type LambdaScheduledEvent = z.infer<typeof LambdaScheduledEvent>;

export const LambdaEvent = z.union([LambdaSqsEvent, LambdaScheduledEvent]);
export type LambdaEvent = z.infer<typeof LambdaEvent>;

export const LambdaEventResponse = z.object({
  batchItemFailures: z.array(z.object({ itemIdentifier: z.string() })),
});
export type LambdaEventResponse = z.infer<typeof LambdaEventResponse>;
