import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { TransientError } from "../engine/step.js";
import { parseModelJson, type ModelClient, type ModelContent } from "./modelClient.js";
import { WIRE_MAX_BODY_BYTES, wireRequestSchema, wireResponseSchema, type WireRequest } from "./agentcoreWire.js";

// Per call. Two attempts plus backoff stay inside a 15 minute Lambda invocation only if one call is shorter.
export const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

const TRANSIENT_NAMES = new Set([
  "ThrottlingException",
  "ThrottledException",
  "ServiceQuotaExceededException",
  "RetryableConflictException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "TimeoutError",
  "AbortError",
]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", ...TRANSIENT_NAMES]);
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// AgentCore wraps a container 4xx/5xx into RuntimeClientError (HTTP 424) whose message carries the
// container status, for example "Received error (503) from runtime. Please check your CloudWatch logs".
const CONTAINER_TRANSIENT_MESSAGE = /Received error \((429|5\d\d)\)/;

export function isTransientAgentCoreError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth++) {
    const o = cur as Record<string, unknown>;
    if (o.name === "RuntimeClientError" && typeof o.message === "string" && CONTAINER_TRANSIENT_MESSAGE.test(o.message)) return true;
    if (typeof o.name === "string" && TRANSIENT_NAMES.has(o.name)) return true;
    if (typeof o.code === "string" && TRANSIENT_CODES.has(o.code)) return true;
    const meta = o.$metadata as { httpStatusCode?: unknown } | undefined;
    const status = meta?.httpStatusCode ?? o.statusCode ?? o.status;
    if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true;
    cur = o.cause;
  }
  return false;
}

export function toWireContent(content: ModelContent[]): WireRequest["content"] {
  return content.map((c) =>
    c.type === "text"
      ? { type: "text" as const, text: c.text }
      : { type: "image" as const, format: c.format, base64: Buffer.from(c.bytes).toString("base64") },
  );
}

const ARN_RE = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/.+/;

export interface AgentCoreModelClientOptions {
  region: string;
  runtimeArn: string;
  client?: BedrockAgentCoreClient;
  timeoutMs?: number;
}

// Runs the Strands agent call on an AgentCore Runtime (AgentService) instead of in-process.
// Request content is never logged or put in error messages.
export function createAgentCoreModelClient(opts: AgentCoreModelClientOptions): ModelClient {
  if (!ARN_RE.test(opts.runtimeArn)) throw new Error("runtimeArn must be a bedrock-agentcore runtime ARN");
  const client = opts.client ?? new BedrockAgentCoreClient({ region: opts.region || "us-west-2" });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async generateJson(req) {
      const wire: WireRequest = {
        modelId: req.modelId,
        system: req.system,
        maxTokens: req.maxTokens,
        content: toWireContent(req.content),
      };
      // Fail before the round trip: a clear permanent error instead of a 424 from the service.
      const checked = wireRequestSchema.safeParse(wire);
      if (!checked.success) {
        const paths = checked.error.issues.map((i) => i.path.join(".") || "(root)");
        throw new Error(`AgentCore request exceeds the wire limits at: ${paths.join(", ")}`);
      }
      const payload = Buffer.from(JSON.stringify(wire), "utf8");
      if (payload.byteLength > WIRE_MAX_BODY_BYTES) {
        throw new Error(`AgentCore request too large: ${payload.byteLength} bytes (limit ${WIRE_MAX_BODY_BYTES}); reduce the number of pages`);
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      let text: string;
      try {
        const call = (async () => {
          const out = await client.send(
            new InvokeAgentRuntimeCommand({
              agentRuntimeArn: opts.runtimeArn,
              // The platform requires a session id of at least 33 characters.
              runtimeSessionId: `${randomUUID()}-${randomUUID().slice(0, 8)}`,
              contentType: "application/json",
              accept: "application/json",
              payload,
            }),
            { abortSignal: abort.signal },
          );
          const status = out.statusCode;
          if (typeof status === "number" && (status === 429 || status >= 500)) {
            throw new TransientError(`AgentCore answered status ${status}`);
          }
          if (typeof status === "number" && (status < 200 || status >= 300)) {
            throw new Error(`AgentCore answered status ${status}`);
          }
          if (!out.response) throw new Error("AgentCore response had no body");
          return out.response.transformToString();
        })();
        call.catch(() => undefined);
        const aborted = new Promise<never>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new TransientError(`AgentCore call timed out after ${timeoutMs} ms`)));
        });
        text = await Promise.race([call, aborted]);
      } catch (e) {
        if (e instanceof TransientError) throw e;
        if (e instanceof Error && e.message.startsWith("AgentCore answered status ")) throw e;
        if (isTransientAgentCoreError(e)) {
          throw new TransientError(`AgentCore call failed: ${e instanceof Error ? e.name : "error"}`);
        }
        throw new Error(`AgentCore call failed: ${e instanceof Error ? e.name : "error"}`);
      } finally {
        clearTimeout(timer);
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("AgentCore response is not valid JSON");
      }
      const parsed = wireResponseSchema.safeParse(json);
      if (!parsed.success) {
        const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
        throw new Error(`AgentCore response failed schema validation at: ${paths.join(", ")}`);
      }
      const envelope = parsed.data;
      if (!envelope.ok) {
        const msg = `AgentService ${envelope.kind}: ${envelope.message}`;
        if (envelope.kind === "transient") throw new TransientError(msg);
        throw new Error(msg);
      }
      const { raw, usage } = envelope;
      // A parse failure carries usage so the paid call is still recorded.
      return { value: parseModelJson(raw, req.schema, usage), raw, usage };
    },
  };
}
