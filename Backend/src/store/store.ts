import type { RunState } from "../contract/schemas.js";
import type { Comment, Run, StepRecord, Version } from "../domain/types.js";

export class AlreadyExists extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyExists";
  }
}

export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

export interface AuditEvent {
  at: number;
  type: string;
  detail: unknown;
}

export interface Store {
  createRun(run: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(): Promise<Run[]>;
  updateRun(id: string, patch: Partial<Run>, expectedState?: RunState): Promise<Run>;
  appendStep(rec: StepRecord): Promise<void>;
  updateStep(runId: string, step: string, attempt: number, patch: Partial<StepRecord>): Promise<void>;
  listSteps(runId: string): Promise<StepRecord[]>;
  addVersion(v: Version): Promise<void>;
  listVersions(runId: string): Promise<Version[]>;
  getVersion(runId: string, n: number): Promise<Version | undefined>;
  addComment(c: Comment): Promise<void>;
  listComments(runId: string, n: number): Promise<Comment[]>;
  appendAudit(runId: string, event: AuditEvent): Promise<void>;
  listAudit(runId: string): Promise<AuditEvent[]>;
  acquireLease(runId: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  // Clears the lease only if owner holds it; otherwise (or for an unknown run) a no-op.
  releaseLease(runId: string, owner: string): Promise<void>;
  listResumable(now: number): Promise<Run[]>;
}
