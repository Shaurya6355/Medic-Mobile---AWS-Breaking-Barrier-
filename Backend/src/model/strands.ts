import { Agent, BedrockModel, ImageBlock, TextBlock } from "@strands-agents/sdk";
import { TransientError } from "../engine/step.js";
import { parseModelJson, type ModelClient, type ModelContent } from "./modelClient.js";

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

export function toStrandsContent(content: ModelContent[]): (TextBlock | ImageBlock)[] {
  return content.map((c) =>
    c.type === "text"
      ? new TextBlock(c.text)
      : new ImageBlock({ format: c.format, source: { bytes: c.bytes } }),
  );
}

export function createStrandsModelClient(opts: { region: string }): ModelClient {
  const region = opts.region || "us-west-2";
  return {
    async generateJson(req) {
      try {
        const model = new BedrockModel({
          region,
          modelId: req.modelId,
          temperature: 0,
          maxTokens: req.maxTokens,
        });
        // retryStrategy null: retries are owned by the orchestration engine (TransientError).
        const agent = new Agent({ model, systemPrompt: req.system, printer: false, retryStrategy: null });
        const result = await agent.invoke(toStrandsContent(req.content));
        const raw = result.toString();
        const usage = result.metrics?.accumulatedUsage;
        return {
          value: parseModelJson(raw, req.schema),
          raw,
          usage: {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            modelId: req.modelId,
          },
        };
      } catch (e) {
        if (isTransientBedrockError(e)) {
          throw new TransientError(e instanceof Error ? e.message : String(e));
        }
        throw e;
      }
    },
  };
}
