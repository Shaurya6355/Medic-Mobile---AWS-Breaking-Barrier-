import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  RuntimeClientError,
  ThrottlingException,
  ValidationException,
  AccessDeniedException,
  ResourceNotFoundException,
  RetryableConflictException,
  ServiceQuotaExceededException,
} from "@aws-sdk/client-bedrock-agentcore";
import { DEFAULT_TIMEOUT_MS, createAgentCoreModelClient } from "../../src/model/agentcore.js";
import { WIRE_MAX_BLOCKS } from "../../src/model/agentcoreWire.js";
import { ModelOutputError } from "../../src/model/modelClient.js";
import { TransientError } from "../../src/engine/step.js";

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-abc";
const schema = z.object({ a: z.number() });
const mock = mockClient(BedrockAgentCoreClient);

const body = (o: unknown) => ({
  contentType: "application/json",
  statusCode: 200,
  // The SDK hands back a stream with transformToString(); only that method is used.
  response: { transformToString: async () => (typeof o === "string" ? o : JSON.stringify(o)) } as never,
});
const ok = (raw: string) => body({ ok: true, raw, usage: { inputTokens: 11, outputTokens: 7, modelId: "m" } });
const req = {
  modelId: "m",
  system: "SECRET-SYSTEM",
  maxTokens: 100,
  schema,
  content: [
    { type: "text" as const, text: "SECRET-TEXT" },
    { type: "image" as const, format: "png" as const, bytes: new Uint8Array([1, 2, 3, 250]) },
  ],
};
const mk = (extra: object = {}) => createAgentCoreModelClient({ region: "us-west-2", runtimeArn: ARN, client: new BedrockAgentCoreClient({ region: "us-west-2" }), ...extra });

beforeEach(() => mock.reset());

describe("createAgentCoreModelClient", () => {
  it("sends the wire request and returns value, raw and usage", async () => {
    mock.on(InvokeAgentRuntimeCommand).resolves(ok('{"a":1}'));
    const r = await mk().generateJson(req);
    expect(r).toEqual({ value: { a: 1 }, raw: '{"a":1}', usage: { inputTokens: 11, outputTokens: 7, modelId: "m" } });
    const input = mock.commandCalls(InvokeAgentRuntimeCommand)[0]!.args[0].input;
    expect(input.agentRuntimeArn).toBe(ARN);
    expect(input.contentType).toBe("application/json");
    expect(input.accept).toBe("application/json");
    expect((input.runtimeSessionId ?? "").length).toBeGreaterThanOrEqual(33);
    const sent = JSON.parse(Buffer.from(input.payload as Uint8Array).toString("utf8"));
    expect(sent).toEqual({
      modelId: "m", system: "SECRET-SYSTEM", maxTokens: 100,
      content: [{ type: "text", text: "SECRET-TEXT" }, { type: "image", format: "png", base64: Buffer.from([1, 2, 3, 250]).toString("base64") }],
    });
  });
  it("uses a fresh session id per call", async () => {
    mock.on(InvokeAgentRuntimeCommand).callsFake(async () => ok('{"a":1}'));
    await mk().generateJson(req);
    await mk().generateJson(req);
    const ids = mock.commandCalls(InvokeAgentRuntimeCommand).map((c) => c.args[0].input.runtimeSessionId);
    expect(new Set(ids).size).toBe(2);
  });
  it("rejects a response of the wrong shape as a permanent error", async () => {
    mock.on(InvokeAgentRuntimeCommand).resolves(body({ raw: 5 }));
    const p = mk().generateJson(req);
    await expect(p).rejects.toThrow(/response/i);
    await expect(p).rejects.not.toBeInstanceOf(TransientError);
  });
  it("rejects a non-JSON response body", async () => {
    mock.on(InvokeAgentRuntimeCommand).resolves(body("<html>"));
    await expect(mk().generateJson(req)).rejects.not.toBeInstanceOf(TransientError);
  });
  it("bad model JSON carries usage", async () => {
    mock.on(InvokeAgentRuntimeCommand).resolves(ok("not json"));
    try {
      await mk().generateJson(req);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelOutputError);
      expect((e as ModelOutputError).usage).toEqual({ inputTokens: 11, outputTokens: 7, modelId: "m" });
    }
  });
  const meta = (c: number) => ({ $metadata: { httpStatusCode: c } });
  const transient: [string, () => Error][] = [
    ["ThrottlingException", () => new ThrottlingException({ message: "x", $metadata: meta(429).$metadata })],
    ["ServiceQuotaExceededException", () => new ServiceQuotaExceededException({ message: "x", $metadata: meta(402).$metadata })],
    ["RetryableConflictException", () => new RetryableConflictException({ message: "x", $metadata: meta(409).$metadata })],
    ["RuntimeClientError 424 wrapping a container 503", () => new RuntimeClientError({ message: "Received error (503) from runtime. Please check your CloudWatch logs for more information.", $metadata: meta(424).$metadata })],
    ["RuntimeClientError 424 wrapping a container 429", () => new RuntimeClientError({ message: "Received error (429) from runtime.", $metadata: meta(424).$metadata })],
    ["RuntimeClientError 424 wrapping a container 500", () => new RuntimeClientError({ message: "Received error (500) from runtime.", $metadata: meta(424).$metadata })],
    ["503 status", () => Object.assign(new Error("x"), meta(503))],
    ["429 status", () => Object.assign(new Error("x"), meta(429))],
    ["ServiceUnavailable name", () => Object.assign(new Error("x"), { name: "ServiceUnavailable" })],
    ["ECONNRESET", () => Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["TimeoutError", () => Object.assign(new Error("x"), { name: "TimeoutError" })],
  ];
  it.each(transient)("maps %s to TransientError", async (_n, make) => {
    mock.on(InvokeAgentRuntimeCommand).rejects(make());
    await expect(mk().generateJson(req)).rejects.toBeInstanceOf(TransientError);
  });
  const permanent: [string, () => Error][] = [
    ["ValidationException", () => new ValidationException({ message: "x", reason: "CannotParse", $metadata: meta(400).$metadata })],
    ["AccessDeniedException", () => new AccessDeniedException({ message: "x", $metadata: meta(403).$metadata })],
    ["ResourceNotFoundException", () => new ResourceNotFoundException({ message: "x", $metadata: meta(404).$metadata })],
    ["RuntimeClientError 424 wrapping a container 400", () => new RuntimeClientError({ message: "Received error (400) from runtime.", $metadata: meta(424).$metadata })],
    ["RuntimeClientError 424 with no status in the message", () => new RuntimeClientError({ message: "x", $metadata: meta(424).$metadata })],
    ["plain Error", () => new Error("x")],
  ];
  it.each(permanent)("maps %s to a permanent error", async (_n, make) => {
    mock.on(InvokeAgentRuntimeCommand).rejects(make());
    const p = mk().generateJson(req);
    await expect(p).rejects.toBeInstanceOf(Error);
    await expect(p).rejects.not.toBeInstanceOf(TransientError);
  });
  it("never puts request content in the error message", async () => {
    mock.on(InvokeAgentRuntimeCommand).rejects(new Error("boom"));
    const e = await mk().generateJson(req).catch((x: Error) => x);
    expect((e as Error).message).not.toMatch(/SECRET/);
  });
  it("times out as a TransientError", async () => {
    mock.on(InvokeAgentRuntimeCommand).callsFake(() => new Promise(() => {}));
    await expect(mk({ timeoutMs: 20 }).generateJson(req)).rejects.toBeInstanceOf(TransientError);
  });
  it("defaults the call timeout to 6 minutes", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(6 * 60 * 1000);
  });

  describe("failure envelope from AgentService", () => {
    const fail = (kind: string, message = "m") => body({ ok: false, kind, message });
    it("maps kind transient to TransientError", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves(fail("transient", "slow down"));
      const p = mk().generateJson(req);
      await expect(p).rejects.toBeInstanceOf(TransientError);
      await expect(p).rejects.toThrow(/slow down/);
    });
    it.each(["permanent", "invalid_request"])("maps kind %s to a plain Error", async (kind) => {
      mock.on(InvokeAgentRuntimeCommand).resolves(fail(kind, "bad thing"));
      const p = mk().generateJson(req);
      await expect(p).rejects.toThrow(/bad thing/);
      await expect(p).rejects.not.toBeInstanceOf(TransientError);
    });
    it("rejects an unknown kind as a permanent error", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves(fail("weird"));
      await expect(mk().generateJson(req)).rejects.not.toBeInstanceOf(TransientError);
    });
    it("bounds a hostile message from the service", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves(fail("permanent", "z".repeat(5000)));
      await expect(mk().generateJson(req)).rejects.toThrow(/response failed schema validation/);
    });
  });

  describe("response statusCode field", () => {
    const withStatus = (statusCode: number) => ({ ...ok('{"a":1}'), statusCode });
    it.each([429, 500, 503])("treats %i as transient even with a body", async (code) => {
      mock.on(InvokeAgentRuntimeCommand).resolves(withStatus(code));
      await expect(mk().generateJson(req)).rejects.toBeInstanceOf(TransientError);
    });
    it("treats another non-2xx as permanent", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves(withStatus(400));
      const p = mk().generateJson(req);
      await expect(p).rejects.toThrow(/400/);
      await expect(p).rejects.not.toBeInstanceOf(TransientError);
    });
    it("accepts 200 and an absent statusCode", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves({ ...ok('{"a":1}'), statusCode: undefined });
      await expect(mk().generateJson(req)).resolves.toMatchObject({ value: { a: 1 } });
    });
  });

  describe("limits checked before sending", () => {
    it("rejects too many blocks as a permanent error without calling AgentCore", async () => {
      const content = Array.from({ length: WIRE_MAX_BLOCKS + 1 }, () => ({ type: "text" as const, text: "x" }));
      const p = mk().generateJson({ ...req, content });
      await expect(p).rejects.toThrow(/content/);
      await expect(p).rejects.not.toBeInstanceOf(TransientError);
      expect(mock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
    });
    it("rejects an oversized payload as a permanent error, without echoing content", async () => {
      // Four images of 40 MB base64 each stay within the per-block cap but pass 90 MiB in total.
      const big = new Uint8Array(30_000_000);
      const content = [0, 1, 2, 3].map(() => ({ type: "image" as const, format: "png" as const, bytes: big }));
      const p = mk().generateJson({ ...req, content });
      await expect(p).rejects.toThrow(/too large/i);
      await expect(p).rejects.not.toBeInstanceOf(TransientError);
      expect(mock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
    });
    it("accepts a full-size 200 page request (602 blocks)", async () => {
      mock.on(InvokeAgentRuntimeCommand).resolves(ok('{"a":1}'));
      const content = Array.from({ length: 602 }, () => ({ type: "text" as const, text: "x" }));
      await expect(mk().generateJson({ ...req, content })).resolves.toBeDefined();
    });
  });

  it("rejects a runtime ARN of another service", () => {
    expect(() => createAgentCoreModelClient({ region: "r", runtimeArn: "arn:aws:s3:::b" })).toThrow(/ARN/);
  });
});
