import type { RunState } from "../contract/schemas.js";

export interface Run {
  runId: string;
  state: RunState;
  pages?: number[];
  currentStep?: string;
  createdAt: string;
  docSha256?: string;
  lease?: { owner: string; expiresAt: number };
}

export interface StepRecord {
  runId: string;
  step: string;
  versionId?: string;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  modelId?: string;
  error?: string;
  artifactRefs: Record<string, string>;
}

export interface Version {
  runId: string;
  n: number;
  parent: number | null;
  author: string;
  createdAt: string;
  artifactKey: string;
}

export interface Comment {
  runId: string;
  n: number;
  itemRef: string;
  author: string;
  text: string;
  createdAt: string;
}
