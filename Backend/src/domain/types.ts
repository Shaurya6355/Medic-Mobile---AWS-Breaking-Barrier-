import type { RunState, SignerRole } from "../contract/schemas.js";

export interface Run {
  runId: string;
  state: RunState;
  pages?: number[];
  currentStep?: string;
  // Set by a manual resume: attempts of `step` numbered up to `attempt` no longer count against the attempt cap.
  attemptFloor?: { step: string; attempt: number };
  createdAt: number;
  docSha256?: string;
  lease?: { owner: string; expiresAt: number };
}

export interface StepRecord {
  runId: string;
  step: string;
  versionId?: string;
  attempt: number;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt?: number;
  latencyMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  modelId?: string;
  error?: string;
  artifactRefs: Record<string, string>;
}

// One signature on one exact version (BRD AR-07). Bound to modelSha: if the content of the version
// is not exactly what was signed, the signature does not count.
export interface Signature {
  runId: string;
  n: number;
  modelSha: string;
  role: SignerRole;
  // Normalised (signoff/identity.ts). AUTH SEAM: from the request body until Cognito (DEC-015).
  userId: string;
  signedAt: number;
  // sha256 of the compile settings the checks used when this signature was given ("none" when no
  // settings were supplied). A release build must use exactly these settings (DEC-020).
  settingsSha?: string;
}

// "locked": both signatures given on the same modelSha (AR-05); never changes again.
// "rejected": the clinician rejected it with a comment (AR-06); it can never be signed or released.
// Absent means draft.
export type VersionStatus = "draft" | "locked" | "rejected";

// The clinician's rejection of one version (BRD AR-06, RR-02).
export interface Rejection {
  role: SignerRole;
  userId: string;
  modelSha: string;
  comment: string;
  // The rule or item the comment is about (for example "rules.R3"), when the clinician names one.
  itemRef?: string;
  // RR-02: the clinician marks the needed change as urgent.
  urgent: boolean;
  rejectedAt: number;
}

export interface Version {
  runId: string;
  n: number;
  parent: number | null;
  author: string;
  createdAt: number;
  // The logic model body. Never rewritten: an edit is always a new version (AR-01).
  artifactKey: string;
  // sha256 (hex) of the exact bytes stored at artifactKey, recorded at save. A release build refuses
  // a body whose bytes differ, including the meta fields modelSha leaves out (DEC-020).
  bodySha256?: string;
  // Which role saved this version (AUTH SEAM: from the request body until Cognito, DEC-015). The
  // open-question check uses it: a question is answered only by the role it is routed to.
  authorRole?: SignerRole;
  // Sign-off record, written only by Store.addSignature. A new version starts with none (AR-02).
  signatures?: Signature[];
  status?: VersionStatus;
  lockedAt?: number;
  // Written only by Store.rejectVersion (AR-06).
  rejection?: Rejection;
  // Who made this version (pipeline, officer agent, tree edit, API save) and the change record (Phase 2c).
  origin?: VersionOrigin;
  changeNote?: string;
  // Artifact key of runs/<id>/changes/v<n>.json and its sha256 (tamper evidence, like bodySha256).
  changeKey?: string;
  changeSha256?: string;
}

export type VersionOrigin = "pipeline" | "officer_agent" | "tree_edit" | "restore" | "api";

export type AgentStatus = "started" | "fixing" | "signed" | "escalated" | "over_budget" | "failed";

// One per (runId, baseVersion): where the officer agent got to. Updated by compare-and-set on status.
export interface AgentState {
  runId: string;
  baseVersion: number;
  status: AgentStatus;
  attempts: number;
  costUsd: number;
  lastError?: string;
  updatedAt: number;
  leaseOwner: string;
}

export interface Comment {
  runId: string;
  n: number;
  itemRef: string;
  author: string;
  text: string;
  createdAt: number;
}
