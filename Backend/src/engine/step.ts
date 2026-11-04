import type { RunState } from "../contract/schemas.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { Run } from "../domain/types.js";
import type { ModelClient } from "../model/modelClient.js";
import type { Store } from "../store/store.js";

export interface StepContext {
  run: Run;
  versionId?: string;
  store: Store;
  artifacts: ArtifactStore;
  model: ModelClient;
  now(): number;
}

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export interface StepResult {
  artifactRefs: Record<string, string>;
  usage?: StepUsage;
}

export interface Step {
  name: string;
  runState: RunState;
  run(ctx: StepContext): Promise<StepResult>;
}

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

// A non-transient failure that happened after a model call had already been paid
// for. The runner records the usage on the failed attempt (DEC-003).
export class UsageError extends Error {
  constructor(
    message: string,
    public readonly usage?: StepUsage,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

// The usage carried by a thrown value, if it has a well-formed `usage` property.
export function usageOf(e: unknown): StepUsage | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const u = (e as { usage?: unknown }).usage;
  if (typeof u !== "object" || u === null) return undefined;
  const { inputTokens, outputTokens, modelId } = u as Record<string, unknown>;
  if (!isCount(inputTokens) || !isCount(outputTokens) || typeof modelId !== "string" || modelId === "") return undefined;
  return { inputTokens, outputTokens, modelId };
}
