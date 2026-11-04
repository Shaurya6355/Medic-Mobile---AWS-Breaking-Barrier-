import { Agent, BedrockModel, ImageBlock, TextBlock } from "@strands-agents/sdk";
import type { InvocationRequest, InvocationSuccess } from "./contract.js";

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

const TRANSIENT_NAMES = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelTimeoutException",
  "InternalServerException",
  "TimeoutError",
  "ModelThrottledError",
  "ModelStreamErrorException",
  "ModelNotReadyException",
  "ServiceUnavailable",
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

export type StrandsContent = (TextBlock | ImageBlock)[];

export interface AgentLike {
  invoke(content: StrandsContent): Promise<{
    toString(): string;
    metrics?: { accumulatedUsage?: { inputTokens?: number; outputTokens?: number } };
  }>;
}

export interface AgentOptions {
  region: string;
  modelId: string;
  maxTokens: number;
  system: string;
}
export type AgentFactory = (opts: AgentOptions) => AgentLike;

export interface AgentDeps {
  createAgent: AgentFactory;
  region?: string;
}

/** Real factory: mirrors Backend/src/model/strands.ts (temperature 0, no printer, no SDK retries). */
export const createStrandsAgent: AgentFactory = (opts) => {
  const model = new BedrockModel({
    region: opts.region,
    modelId: opts.modelId,
    temperature: 0,
    maxTokens: opts.maxTokens,
  });
  // retryStrategy null: retries are owned by the orchestrator (503 transient).
  return new Agent({ model, systemPrompt: opts.system, printer: false, retryStrategy: null });
};

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeBase64(s: string): Uint8Array {
  if (s.length === 0 || s.length % 4 !== 0 || !B64.test(s)) {
    throw new BadRequestError("invalid base64 image data");
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export async function runAgent(req: InvocationRequest, deps: AgentDeps): Promise<InvocationSuccess> {
  // Decode first so a bad image fails fast, before any paid call.
  const content: StrandsContent = req.content.map((c) =>
    c.type === "text"
      ? new TextBlock(c.text)
      : new ImageBlock({ format: c.format, source: { bytes: decodeBase64(c.base64) } }),
  );
  const region = deps.region || process.env.AWS_REGION || "us-west-2";
  const agent = deps.createAgent({ region, modelId: req.modelId, maxTokens: req.maxTokens, system: req.system });
  const result = await agent.invoke(content);
  const acc = result.metrics?.accumulatedUsage;
  return {
    ok: true,
    raw: result.toString(),
    usage: { inputTokens: acc?.inputTokens ?? 0, outputTokens: acc?.outputTokens ?? 0, modelId: req.modelId },
  };
}
