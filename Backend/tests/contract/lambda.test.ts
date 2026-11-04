import { describe, expect, expectTypeOf, it } from "vitest";
import type { SQSBatchResponse } from "aws-lambda";
import type { LambdaEventResponse } from "../../src/contract/schemas.js";
import { routes } from "../../src/contract/routes.js";
import { LambdaEventResponse as LambdaEventResponseSchema, LambdaEvent, LambdaScheduledEvent, LambdaSqsEnvelope, LambdaSqsEvent, LambdaSqsRecord } from "../../src/contract/schemas.js";

describe("events route", () => {
  it("exists but is never proxiable", () => {
    expect(routes.events()).toBe("/events");
    expect(routes.pattern.events).toBe("/events");
    expect(routes.proxiable).not.toContain(routes.pattern.events);
  });
});

const rec = (id: string) => ({ messageId: id, body: "{}", eventSource: "aws:sqs", attributes: { a: 1 } });

describe("LambdaSqsEvent", () => {
  it("accepts records and keeps extra fields", () => {
    const r = LambdaSqsEvent.safeParse({ Records: [rec("a")] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.Records[0]).toMatchObject({ eventSource: "aws:sqs" });
  });
  it("allows up to 100 records", () => {
    expect(LambdaSqsEvent.safeParse({ Records: Array.from({ length: 100 }, (_, i) => rec(String(i))) }).success).toBe(true);
    expect(LambdaSqsEvent.safeParse({ Records: Array.from({ length: 101 }, (_, i) => rec(String(i))) }).success).toBe(false);
  });
  it.each([[{ Records: [] }], [{ Records: [{ messageId: "a" }] }], [{ Records: [{ body: "x" }] }], [{ Records: [{ messageId: 1, body: "x" }] }], [{}], [null]])(
    "rejects %j",
    (v) => expect(LambdaSqsEvent.safeParse(v).success).toBe(false),
  );
});

describe("LambdaScheduledEvent", () => {
  it("accepts source aws.events or detail-type Scheduled Event", () => {
    expect(LambdaScheduledEvent.safeParse({ source: "aws.events", id: "x" }).success).toBe(true);
    expect(LambdaScheduledEvent.safeParse({ "detail-type": "Scheduled Event" }).success).toBe(true);
  });
  it.each([[{}], [{ source: "other" }], [{ "detail-type": "Other" }], [null]])("rejects %j", (v) =>
    expect(LambdaScheduledEvent.safeParse(v).success).toBe(false),
  );
});

describe("LambdaEvent", () => {
  it("is the union of both", () => {
    expect(LambdaEvent.safeParse({ source: "aws.events" }).success).toBe(true);
    expect(LambdaEvent.safeParse({ Records: [rec("a")] }).success).toBe(true);
    expect(LambdaEvent.safeParse({ hello: 1 }).success).toBe(false);
  });
});

describe("LambdaEventResponse", () => {
  it("is exactly Lambda's SQSBatchResponse (compile-time check)", () => {
    expectTypeOf<LambdaEventResponse>().toEqualTypeOf<SQSBatchResponse>();
    const viaSchema: SQSBatchResponse = LambdaEventResponseSchema.parse({ batchItemFailures: [] });
    expect(viaSchema).toEqual({ batchItemFailures: [] });
  });
  it("has batchItemFailures", () => {
    expect(LambdaEventResponseSchema.safeParse({ batchItemFailures: [{ itemIdentifier: "a" }] }).success).toBe(true);
    expect(LambdaEventResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("lenient envelope and record", () => {
  it("envelope accepts malformed records but bounds the count", () => {
    expect(LambdaSqsEnvelope.safeParse({ Records: [1, null, { x: 1 }] }).success).toBe(true);
    expect(LambdaSqsEnvelope.safeParse({ Records: [] }).success).toBe(false);
    expect(LambdaSqsEnvelope.safeParse({ Records: Array.from({ length: 101 }, () => 1) }).success).toBe(false);
    expect(LambdaSqsEnvelope.safeParse({ Records: "x" }).success).toBe(false);
    expect(LambdaSqsEnvelope.safeParse({}).success).toBe(false);
  });
  it("record rejects oversize body and bad ids, accepts extras", () => {
    expect(LambdaSqsRecord.safeParse({ messageId: "a", body: "x", extra: 1 }).success).toBe(true);
    expect(LambdaSqsRecord.safeParse({ messageId: "a", body: "x".repeat(1024 * 1024 + 1) }).success).toBe(false);
    expect(LambdaSqsRecord.safeParse({ messageId: "", body: "x" }).success).toBe(false);
    expect(LambdaSqsRecord.safeParse({ messageId: "a" }).success).toBe(false);
  });
  it("scheduled event rejects non-matching values and keeps passthrough fields", () => {
    const r = LambdaScheduledEvent.safeParse({ source: "aws.events", account: "1" });
    expect(r.success && (r.data as Record<string, unknown>)["account"]).toBe("1");
    expect(LambdaScheduledEvent.safeParse({ source: "aws.s3" }).success).toBe(false);
  });
  it("response rejects bad item shapes", () => {
    expect(LambdaEventResponseSchema.safeParse({ batchItemFailures: [{ itemIdentifier: 1 }] }).success).toBe(false);
    expect(LambdaEventResponseSchema.safeParse({ batchItemFailures: [{}] }).success).toBe(false);
  });
});
