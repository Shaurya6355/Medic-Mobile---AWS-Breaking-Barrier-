import { Agent, BedrockModel, ImageBlock, TextBlock } from "@strands-agents/sdk";
import { TransientError } from "../engine/step.js";
import { parseModelJson, type ModelClient, type ModelContent } from "./modelClient.js";

// Per call. Keeps one attempt well inside a 15 minute Lambda invocation.
export const DEFAULT_BEDROCK_TIMEOUT_MS = 6 * 60 * 1000;

const TRANSIENT_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelTimeoutException",
  "InternalServerException",
  "TimeoutError",
  "ModelThrottledError",
]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", ...TRANSIENT_NAMES]);
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

export function isTransientBedrockError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth++) {
    const o = cur as Record<string, unknown>;
    if (typeof o.name === "string" && TRANSIENT_NAMES.has(o.name)) return true;
    if (typeof o.code === "string" && TRANSIENT_CODES.has(o.code)) return true;
    const meta = o.$metadata as { httpStatusCode?: unknown } | undefined;
    const status = meta?.httpStatusCode ?? o.statusCode ?? o.status;
    if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true;
    cur = o.cause;
  }
  return false;
}

/**
 * Claude Haiku 5.5 rejects any temperature but its default ("`temperature` is deprecated for this model", ERR-012,
 * found with direct test calls), so none is sent for it. Every other model keeps temperature 0.
 */
const NO_TEMPERATURE = /claude-haiku-5/;
export function temperatureSetting(modelId: string): { temperature?: number } {
  return NO_TEMPERATURE.test(modelId) ? {} : { temperature: 0 };
}

export function toStrandsContent(content: ModelContent[]): (TextBlock | ImageBlock)[] {
  return content.map((c) =>
    c.type === "text"
      ? new TextBlock(c.text)
      : new ImageBlock({ format: c.format, source: { bytes: c.bytes } }),
  );
}

export function createStrandsModelClient(opts: { region: string; timeoutMs?: number }): ModelClient {
  const region = opts.region || "us-west-2";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BEDROCK_TIMEOUT_MS;
  return {
    async generateJson(req) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const model = new BedrockModel({
          region,
          modelId: req.modelId,
          ...temperatureSetting(req.modelId),
          maxTokens: req.maxTokens,
        });
        // retryStrategy null: retries are owned by the orchestration engine (TransientError).
        const agent = new Agent({ model, systemPrompt: req.system, printer: false, retryStrategy: null });
        // Strands supports cancelSignal: on abort it stops at its next checkpoint and returns
        // stopReason "cancelled". The race below is a backstop for a call stuck inside the SDK;
        // it does not cancel anything by itself.
        const timedOut = new Promise<never>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new TransientError(`Bedrock call timed out after ${timeoutMs} ms`)));
        });
        const call = agent.invoke(toStrandsContent(req.content), { cancelSignal: abort.signal });
        call.catch(() => undefined);
        const result = await Promise.race([call, timedOut]);
        if (result.stopReason === "cancelled") throw new TransientError(`Bedrock call timed out after ${timeoutMs} ms`);
        const raw = result.toString();
        const acc = result.metrics?.accumulatedUsage;
        const usage = {
          inputTokens: acc?.inputTokens ?? 0,
          outputTokens: acc?.outputTokens ?? 0,
          modelId: req.modelId,
        };
        // A parse failure carries usage so the paid call is still recorded.
        return { value: parseModelJson(raw, req.schema, usage), raw, usage };
      } catch (e) {
        if (isTransientBedrockError(e)) {
          throw new TransientError(e instanceof Error ? e.message : String(e));
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
