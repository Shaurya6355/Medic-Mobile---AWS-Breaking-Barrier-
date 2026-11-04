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

export interface StepResult {
  artifactRefs: Record<string, string>;
  usage?: { inputTokens: number; outputTokens: number; modelId: string };
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
