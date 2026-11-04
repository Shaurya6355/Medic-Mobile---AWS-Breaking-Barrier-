import type { Signature, VersionStatus } from "../domain/types.js";
import { OFFICER_AGENT_ID, sameUser } from "./identity.js";

/**
 * Pure sign-off rules (BRD AR-02, AR-03, AR-05, AR-07, AR-08; DEC-019, DEC-020). No I/O: the store enforces
 * the same rules atomically when a signature is written, and the release path (Signoff.verifyLocked) re-checks
 * them together with the stored bytes, the compile settings and freshly run checks before a build.
 *
 * What this does NOT stop: a person who can write the versions table directly can forge a locked item with
 * two signatures, because a signature is not yet cryptographically tied to a verified identity (DEC-015,
 * Cognito, not built). A hand-edited ARTIFACT (body or findings) is caught: the body by its modelSha and
 * the bytes sha on the version row, the findings because no release or signature reads stored findings.
 * userIds are compared normalised (identity.ts).
 */

/** What is needed to judge a version's sign-off: its identity, status and signatures. */
export interface LockEvidence {
  runId: string;
  n: number;
  status?: VersionStatus | undefined;
  signatures?: readonly Signature[] | undefined;
}

/**
 * The signatures that still hold for content with this modelSha: the program officer's first, then the
 * clinician's, both on this sha and this version, by two different people, the clinician not before the
 * officer. Anything else does not count.
 */
export function validSignatures(signatures: readonly Signature[] | undefined, sha: string, ref: { runId: string; n: number }): Signature[] {
  const sigs = signatures ?? [];
  const binds = (s: Signature): boolean => s.modelSha === sha && s.runId === ref.runId && s.n === ref.n;
  const officer = sigs[0];
  if (officer === undefined || officer.role !== "program_officer" || officer.userId !== OFFICER_AGENT_ID || !binds(officer)) return [];
  const clinician = sigs[1];
  if (
    clinician === undefined ||
    clinician.role !== "clinician" ||
    !binds(clinician) ||
    sameUser(clinician.userId, officer.userId) ||
    clinician.signedAt < officer.signedAt
  ) {
    return [officer];
  }
  return [officer, clinician];
}

export type LockCheck = { ok: true } | { ok: false; reason: string };

/**
 * A version may be built for release only if this holds (AR-08). With `settingsSha`, both signatures must
 * have been given with exactly those compile settings (DEC-020).
 */
export function verifyLock(sha: string, v: LockEvidence, opts: { settingsSha?: string } = {}): LockCheck {
  const no = (reason: string): LockCheck => ({ ok: false, reason: `version ${v.n}: ${reason}` });
  if (v.status !== "locked") return no("is not locked (it needs the program officer's and then the clinician's signature)");
  const sigs = v.signatures ?? [];
  if (sigs.length !== 2) return no(`needs exactly two signatures, has ${sigs.length}`);
  const [a, b] = sigs as [Signature, Signature];
  if (a.role !== "program_officer" || b.role !== "clinician") return no("must be signed by the officer agent first, then the clinician");
  if (a.userId !== OFFICER_AGENT_ID) return no("the first signature is not the officer agent's (DEC-024)");
  if (sameUser(a.userId, b.userId)) return no("the clinician signed with the officer agent's identity");
  if (b.signedAt < a.signedAt) return no("the clinician signature is dated before the officer agent signature");
  for (const s of sigs) {
    if (s.runId !== v.runId || s.n !== v.n) return no(`the ${s.role} signature belongs to another version`);
    if (s.modelSha !== sha) return no(`the ${s.role} signature was given for different content (signed ${s.modelSha.slice(0, 12)}, now ${sha.slice(0, 12)})`);
    if (opts.settingsSha !== undefined && (s.settingsSha ?? "none") !== opts.settingsSha) {
      return no(
        `the ${s.role} signature was given with other compile settings (signed ${(s.settingsSha ?? "none").slice(0, 12)}, build ${opts.settingsSha.slice(0, 12)}); build with the settings that were reviewed`,
      );
    }
  }
  return { ok: true };
}

export type ApprovalStatus = "awaiting_officer" | "awaiting_clinician" | "locked" | "rejected" | "superseded" | "invalid";

/** Where a version stands, for the status view. Only the latest version can still collect signatures. */
export function approvalStatus(v: LockEvidence, sha: string, isLatest: boolean): ApprovalStatus {
  if (v.status === "locked") return verifyLock(sha, v).ok ? "locked" : "invalid";
  if (v.status === "rejected") return "rejected";
  if (!isLatest) return "superseded";
  return validSignatures(v.signatures, sha, v).length === 0 ? "awaiting_officer" : "awaiting_clinician";
}
