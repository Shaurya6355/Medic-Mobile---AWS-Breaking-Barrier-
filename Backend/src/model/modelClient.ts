import type { z } from "zod";
import { UsageError, type StepUsage } from "../engine/step.js";

export type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; format: "png"; bytes: Uint8Array };

export interface ModelRequest<T> {
  modelId: string;
  system: string;
  content: ModelContent[];
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface ModelClient {
  generateJson<T>(req: ModelRequest<T>): Promise<{
    value: T;
    usage: { inputTokens: number; outputTokens: number; modelId: string };
    raw: string;
  }>;
}

// usage: tokens of the call that produced the bad output, so the cost is recorded.
export class ModelOutputError extends UsageError {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly issues?: string[],
    usage?: StepUsage,
  ) {
    super(message, usage);
    this.name = "ModelOutputError";
  }
}

const RAW_IN_MESSAGE = 200;

export function parseModelJson<T>(raw: string, schema: z.ZodType<T>, usage?: StepUsage): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Only the start of raw goes in the message; the full text stays on .raw.
    const start = raw.length > RAW_IN_MESSAGE ? `${raw.slice(0, RAW_IN_MESSAGE)}...` : raw;
    throw new ModelOutputError(`Model output is not valid JSON (starts: ${start})`, raw, undefined, usage);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ModelOutputError(
      `Model output failed schema validation: ${issues.join("; ")}`,
      raw,
      issues,
      usage,
    );
  }
  return result.data;
}

export type FakeResponse = {
  raw: string;
  usage?: { inputTokens: number; outputTokens: number; modelId: string };
};

export class FakeModelClient implements ModelClient {
  readonly calls: ModelRequest<unknown>[] = [];
  private readonly queue: (FakeResponse | Error)[];

  constructor(responses: (FakeResponse | Error)[]) {
    this.queue = [...responses];
  }

  async generateJson<T>(req: ModelRequest<T>) {
    this.calls.push(req as ModelRequest<unknown>);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeModelClient: response queue is empty");
    if (next instanceof Error) throw next;
    const usage = next.usage ?? { inputTokens: 0, outputTokens: 0, modelId: req.modelId };
    const value = parseModelJson(next.raw, req.schema, usage);
    return { value, usage, raw: next.raw };
  }
}
