import type { RunState } from "../contract/schemas.js";
import type { Comment, Rejection, Run, Signature, StepRecord, Version } from "../domain/types.js";

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
  // Appends one signature to version (sig.runId, sig.n) in one atomic, conditional write and returns the
  // updated version. Conflict unless ALL hold: the version exists and is the latest of its run (AR-04),
  // it is neither locked (AR-05) nor rejected (AR-06); for program_officer it has no signature yet; for
  // clinician it has exactly the officer's signature, on the same modelSha (AR-07) and the same
  // settingsSha, by a different userId (separation of duties). userIds are compared normalised
  // (signoff/identity.ts) and the signature is stored with the normalised userId.
  // The clinician's signature also sets status "locked" and lockedAt = signedAt. The caller checks the
  // findings gate and the modelSha of the body first; this is the last line of defence against races.
  addSignature(sig: Signature): Promise<Version>;
  // Marks version (runId, n) rejected (AR-06) in one atomic, conditional write and returns it.
  // Conflict unless the version exists, is the latest of its run, is neither locked nor rejected, and
  // carries exactly the program officer's signature on rejection.modelSha by another userId than
  // rejection.userId. Signatures stay as they are (history, AR-10).
  rejectVersion(runId: string, n: number, rejection: Rejection): Promise<Version>;
  addComment(c: Comment): Promise<void>;
  listComments(runId: string, n: number): Promise<Comment[]>;
  appendAudit(runId: string, event: AuditEvent): Promise<void>;
  listAudit(runId: string): Promise<AuditEvent[]>;
  acquireLease(runId: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  // Clears the lease only if owner holds it; otherwise (or for an unknown run) a no-op.
  releaseLease(runId: string, owner: string): Promise<void>;
  listResumable(now: number): Promise<Run[]>;
}
