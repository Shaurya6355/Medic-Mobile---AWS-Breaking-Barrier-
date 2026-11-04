import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { NotFound } from "../artifacts/artifactStore.js";
import type { CompileSettings } from "../compiler/types.js";
import { SignerRole, type RejectRequest, type RunState, type SignRequest } from "../contract/schemas.js";
import { canTransition } from "../domain/stateMachine.js";
import type { Rejection, Run, Signature, Version } from "../domain/types.js";
import type { Model } from "../logic/index.js";
import { Conflict, type Store } from "../store/store.js";
import { isMeaningfulText } from "../validation/context.js";
import type { Finding } from "../validation/finding.js";
import type { FindingGroup } from "../validation/gates.js";
import {
  VersionNotFound,
  computeFindings,
  ensureFindings,
  inputsFor,
  settingsShaOf,
  type CheckInputs,
  type CheckInputsProvider,
  type FindingsRecord,
  type LoadedVersion,
  type StoreIo,
} from "./checks.js";
import { InvalidUserId, normaliseUserId, sameUser } from "./identity.js";
import { approvalStatus, validSignatures, verifyLock, type ApprovalStatus } from "./rules.js";

/**
 * Sign-off of logic model versions (BRD AR-01 to AR-10, section 4; DEC-019). Humans approve, code enforces:
 * - the program officer signs first, the clinician second, two different people;
 * - a signature names the modelSha the signer reviewed and binds to exactly that content;
 * - a signature is refused while the findings gate for that role has blocking findings;
 * - both signatures on the same sha lock the version; any later edit is a new version with none;
 * - only the latest version can collect signatures; a locked version stays locked;
 * - the clinician may reject the officer-signed version with a comment (AR-06); it then never moves again;
 * - signatures and release builds never trust stored findings: they run the checks again (DEC-020);
 * - only the newest locked version can be built, with the settings both signers' checks used, from the
 *   exact bytes recorded at save (DEC-020).
 *
 * AUTH SEAM (DEC-015, not built): the caller passes role and userId. The API takes them from the request
 * body for now. With Cognito they come from the verified token (userId = token sub); nothing else here
 * changes. userIds are compared normalised (identity.ts).
 */

export type SignoffErrorStatus = 400 | 403 | 404 | 409 | 422;

export class SignoffError extends Error {
  constructor(
    readonly status: SignoffErrorStatus,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SignoffError";
  }
}

export interface SignoffDeps {
  store: Store;
  artifacts: ArtifactStore;
  now?: () => number;
  /** Lease held while onVersionSaved moves the run through checking (default 120 s). */
  leaseMs?: number;
  /** Golden cases and compile settings of a run. Default: defaultCheckInputs (run artifacts, then env). */
  inputs?: CheckInputsProvider;
}

export interface FindingsView {
  runId: string;
  n: number;
  modelSha: string;
  audience: SignerRole | "all";
  claim: FindingsRecord["claim"];
  claimText: string;
  blocking: number;
  gates: Omit<FindingsRecord["gates"], "blockers">;
  context: FindingsRecord["context"];
  /** Each check that did not run and why, in plain words (DEC-020). */
  checksNotRun: string[];
  /** With an audience: the findings addressed to that role, grouped by severity, worded for it. */
  groups: FindingGroup[];
  /** Without an audience: every finding. */
  findings?: Finding[];
}

export interface VersionStatusView {
  runId: string;
  n: number;
  latest: number;
  isLatest: boolean;
  runState: RunState;
  modelSha: string;
  modelValid: boolean;
  status: ApprovalStatus;
  /** Everything stored, valid or not (history, AR-10). */
  signatures: Signature[];
  /** The ones that still hold for the current content. */
  validSignatures: Signature[];
  lockedAt?: number;
  rejection?: Rejection;
  gates: Omit<FindingsRecord["gates"], "blockers">;
  checksNotRun: string[];
  /** The most recent locked version of the run: the only one that can be released (AR-09). */
  latestLocked: number | null;
  nextStep: string;
}

export interface SignResult {
  signature: Signature;
  status: ApprovalStatus;
  runState: RunState;
  /** The checks that did not run for this signature, in plain words (never silent, DEC-020). */
  checksNotRun: string[];
}

export interface RejectResult {
  rejection: Rejection;
  status: "rejected";
  runState: RunState;
}

export interface LockedVersion {
  model: Model;
  sha: string;
  version: Version;
  /** Run just now with the build's settings; never read from the store. */
  findings: FindingsRecord;
  settingsSha: string;
  inputs: CheckInputs;
}

const ROLE_STATE: Record<SignerRole, RunState> = { program_officer: "awaiting_officer", clinician: "awaiting_clinician" };
const NEXT_STATE: Record<SignerRole, RunState> = { program_officer: "awaiting_clinician", clinician: "locked" };
/** States from which a newly saved version goes back through checking. */
const REVIEW_STATES: readonly RunState[] = ["in_review", "awaiting_officer", "awaiting_clinician", "locked"];

const gatesOnly = (g: FindingsRecord["gates"]): Omit<FindingsRecord["gates"], "blockers"> => ({
  canOfficerSign: g.canOfficerSign,
  canClinicianSign: g.canClinicianSign,
  canCompile: g.canCompile,
  summary: g.summary,
});

export class Signoff {
  readonly io: StoreIo;
  private readonly leaseMs: number;

  constructor(deps: SignoffDeps) {
    this.io = { store: deps.store, artifacts: deps.artifacts, now: deps.now ?? Date.now, ...(deps.inputs !== undefined ? { inputs: deps.inputs } : {}) };
    this.leaseMs = deps.leaseMs ?? 120_000;
  }

  private async mustRun(runId: string): Promise<Run> {
    const run = await this.io.store.getRun(runId);
    if (!run) throw new SignoffError(404, "not_found", `Run ${runId} not found`);
    return run;
  }

  private async notFoundAs404<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if (e instanceof VersionNotFound || e instanceof NotFound) throw new SignoffError(404, "not_found", e.message);
      throw e;
    }
  }

  /** Cached findings, for the views only. */
  private ensure(runId: string, n: number) {
    return this.notFoundAs404(ensureFindings(this.io, runId, n));
  }

  /** Findings run now (for a signature, a rejection or a build); the cache is rewritten as a side effect. */
  private fresh(runId: string, n: number, override?: CheckInputs) {
    return this.notFoundAs404(computeFindings(this.io, runId, n, override));
  }

  private static userIdOf(raw: string): string {
    try {
      return normaliseUserId(raw);
    } catch (e) {
      if (e instanceof InvalidUserId) throw new SignoffError(400, "invalid_user_id", e.message);
      throw e;
    }
  }

  /** The stored bytes must be the ones recorded at save (DEC-020); versions saved before that have no record. */
  private static checkBytes(loaded: LoadedVersion): void {
    const want = loaded.version.bodySha256;
    if (want !== undefined && want !== loaded.bytesSha) {
      throw new SignoffError(409, "body_changed", `The stored body of version ${loaded.version.n} is not the one saved (its bytes changed); it cannot be signed or built`);
    }
  }

  /**
   * Self-heal (DEC-020): a save while another worker held the lease adds the version without moving the run.
   * When the run waits for a signature that the newest version cannot take (awaiting_clinician or locked
   * with no valid officer signature on the newest version), move it back to awaiting_officer through checking.
   */
  private async heal(run: Run): Promise<Run> {
    if (!["awaiting_clinician", "locked"].includes(run.state)) return run;
    const versions = await this.io.store.listVersions(run.runId);
    const newest = versions.reduce<Version | undefined>((m, v) => (m === undefined || v.n > m.n ? v : m), undefined);
    if (newest === undefined) return run;
    let target: RunState | undefined;
    if (newest.status === "locked") target = "locked";
    else if (newest.status === "rejected") target = "awaiting_officer";
    else {
      let sha: string | undefined;
      try {
        sha = (await ensureFindings(this.io, run.runId, newest.n)).loaded.sha;
      } catch {
        return run;
      }
      target = validSignatures(newest.signatures, sha, newest).length === 0 ? "awaiting_officer" : "awaiting_clinician";
    }
    if (target === run.state) return run;
    // Legal paths only (domain/stateMachine.ts): awaiting_clinician -> locked directly; otherwise back
    // through checking to awaiting_officer, then on to awaiting_clinician when the officer has signed.
    const path: RunState[] =
      run.state === "awaiting_clinician" && target === "locked"
        ? ["locked"]
        : target === "awaiting_clinician"
          ? ["checking", "awaiting_officer", "awaiting_clinician"]
          : ["checking", "awaiting_officer"];
    try {
      let from = run.state;
      for (const to of path) {
        await this.transition(run.runId, from, to);
        from = to;
      }
      await this.io.store.appendAudit(run.runId, { at: this.io.now(), type: "run_state_healed", detail: { from: run.state, to: target, newest: newest.n } });
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
    return this.mustRun(run.runId);
  }

  async findingsRecord(runId: string, n: number): Promise<FindingsRecord> {
    await this.mustRun(runId);
    return (await this.ensure(runId, n)).record;
  }

  async findingsView(runId: string, n: number, audience?: SignerRole): Promise<FindingsView> {
    const rec = await this.findingsRecord(runId, n);
    const base = {
      runId,
      n,
      modelSha: rec.modelSha,
      claim: rec.claim,
      claimText: rec.claimText,
      blocking: rec.blocking,
      gates: gatesOnly(rec.gates),
      context: rec.context,
      checksNotRun: rec.checksNotRun,
    };
    if (audience === undefined) return { ...base, audience: "all", groups: [], findings: rec.findings };
    return { ...base, audience, groups: rec.views[audience] };
  }

  async status(runId: string, n: number): Promise<VersionStatusView> {
    const run = await this.heal(await this.mustRun(runId));
    const { record, loaded } = await this.ensure(runId, n);
    const versions = await this.io.store.listVersions(runId);
    const latest = versions.reduce((m, v) => Math.max(m, v.n), 0);
    const v = loaded.version;
    const status = approvalStatus(v, loaded.sha, v.n === latest);
    const locked = versions.filter((x) => x.status === "locked").map((x) => x.n);
    return {
      runId,
      n,
      latest,
      isLatest: v.n === latest,
      runState: run.state,
      modelSha: loaded.sha,
      modelValid: loaded.model !== undefined,
      status,
      signatures: v.signatures ?? [],
      validSignatures: validSignatures(v.signatures, loaded.sha, v),
      ...(v.lockedAt !== undefined ? { lockedAt: v.lockedAt } : {}),
      ...(v.rejection !== undefined ? { rejection: v.rejection } : {}),
      gates: gatesOnly(record.gates),
      checksNotRun: record.checksNotRun,
      latestLocked: locked.length === 0 ? null : Math.max(...locked),
      nextStep: nextStep(status, record),
    };
  }

  /**
   * Records one signature. `endpointRole` is the role the endpoint is for; `req.role` must equal it.
   * Error codes: 404 not_found / unknown_role; 403 role_mismatch / separation_of_duties;
   * 409 superseded / sha_mismatch / locked / already_signed / officer_signature_required / wrong_state / conflict;
   * 422 invalid_logic_model / blocked.
   */
  async sign(runId: string, n: number, endpointRole: string, req: SignRequest): Promise<SignResult> {
    const parsedRole = SignerRole.safeParse(endpointRole);
    if (!parsedRole.success) throw new SignoffError(404, "unknown_role", `No signature endpoint for role ${endpointRole}`);
    const role = parsedRole.data;
    // AUTH SEAM (DEC-015): req.role and req.userId are trusted as given. With Cognito, the role comes from
    // the token's group and this check rejects a user signing at the other role's endpoint.
    if (req.role !== role) throw new SignoffError(403, "role_mismatch", `This endpoint is for the ${role} signature; the request says ${req.role}`);

    const userId = Signoff.userIdOf(req.userId);

    const run = await this.heal(await this.mustRun(runId));
    const { record, loaded } = await this.fresh(runId, n);
    const v = loaded.version;
    const versions = await this.io.store.listVersions(runId);
    const latest = versions.reduce((m, x) => Math.max(m, x.n), 0);

    if (v.status === "locked") throw new SignoffError(409, "locked", `Version ${n} is locked; edits make a new version`);
    if (v.status === "rejected") throw new SignoffError(409, "rejected", `Version ${n} was rejected by the clinician; the fix is a new version (AR-06)`);
    if (v.n !== latest) {
      throw new SignoffError(409, "superseded", `Version ${n} was replaced by version ${latest}; signatures start over on the new version`);
    }
    if (loaded.model === undefined) {
      throw new SignoffError(422, "invalid_logic_model", "The version is not a valid logic model and cannot be signed", { issues: loaded.issues });
    }
    Signoff.checkBytes(loaded);
    if (req.modelSha !== loaded.sha) {
      throw new SignoffError(409, "sha_mismatch", "The version's content is not what you reviewed; reload it and review again", { modelSha: loaded.sha });
    }
    const valid = validSignatures(v.signatures, loaded.sha, v);
    if (role === "program_officer" && (v.signatures ?? []).length > 0) {
      throw new SignoffError(409, "already_signed", `The program officer has already signed version ${n}`);
    }
    if (role === "clinician") {
      const officer = valid[0];
      if (officer === undefined) throw new SignoffError(409, "officer_signature_required", "The program officer signs first (AR-03)");
      if (sameUser(officer.userId, userId)) {
        throw new SignoffError(403, "separation_of_duties", "The same person cannot sign as program officer and as clinician");
      }
      if ((officer.settingsSha ?? "none") !== record.settingsSha) {
        throw new SignoffError(409, "settings_changed", "The form settings changed since the program officer signed; the program officer signs again on a new version", {
          settingsSha: record.settingsSha,
        });
      }
    }
    if (run.state !== ROLE_STATE[role]) {
      throw new SignoffError(409, "wrong_state", `The run is in state ${run.state}; the ${role} signs in state ${ROLE_STATE[role]}`, { runState: run.state });
    }
    const gateOpen = role === "program_officer" ? record.gates.canOfficerSign : record.gates.canClinicianSign;
    if (!gateOpen) {
      const ids = new Set(role === "program_officer" ? record.gates.blockers.officer : record.gates.blockers.clinician);
      const blockers = record.views[role]
        .flatMap((g) => g.findings)
        .filter((f) => ids.has(f.id))
        .map((f) => ({ id: f.id, code: f.code, message: f.message, subjects: f.subjects }));
      throw new SignoffError(422, "blocked", record.gates.summary, { blockers, summary: record.gates.summary, checksNotRun: record.checksNotRun });
    }

    const signature: Signature = { runId, n, modelSha: loaded.sha, role, userId, signedAt: this.io.now(), settingsSha: record.settingsSha };
    let updated: Version;
    try {
      updated = await this.io.store.addSignature(signature);
    } catch (e) {
      if (e instanceof Conflict) throw new SignoffError(409, "conflict", "The version changed while signing; reload and try again");
      throw e;
    }
    await this.io.store.appendAudit(runId, {
      at: signature.signedAt,
      type: "signature",
      detail: { n, role, userId, modelSha: loaded.sha, settingsSha: record.settingsSha, inputsSha: record.inputsSha, checksVersion: record.checksVersion, checksNotRun: record.checksNotRun },
    });
    if (updated.status === "locked") {
      await this.io.store.appendAudit(runId, { at: signature.signedAt, type: "version_locked", detail: { n, modelSha: loaded.sha, settingsSha: record.settingsSha } });
    }
    const runState = await this.tryTransition(runId, ROLE_STATE[role], NEXT_STATE[role]);
    return { signature, status: approvalStatus(updated, loaded.sha, true), runState, checksNotRun: record.checksNotRun };
  }

  /**
   * The clinician rejects the officer-signed latest version with a comment (BRD AR-06, RR-02). The version
   * is marked rejected (kept, never signable or buildable), the comment is stored against the item it names,
   * and the run goes back to the program officer, whose fix is a new version.
   * Error codes: 400 invalid_user_id; 403 role_mismatch / separation_of_duties; 404 not_found;
   * 409 locked / rejected / superseded / sha_mismatch / officer_signature_required / wrong_state / conflict / body_changed;
   * 422 comment_required / invalid_logic_model.
   */
  async reject(runId: string, n: number, req: RejectRequest): Promise<RejectResult> {
    if (req.role !== "clinician") throw new SignoffError(403, "role_mismatch", "Only the clinician rejects a version (AR-06)");
    const userId = Signoff.userIdOf(req.userId);
    const comment = req.comment.trim();
    if (!isMeaningfulText(comment)) {
      throw new SignoffError(422, "comment_required", "Say what is wrong and what the program officer should change (a full sentence, AR-06)");
    }
    const run = await this.heal(await this.mustRun(runId));
    const { loaded } = await this.fresh(runId, n);
    const v = loaded.version;
    const latest = (await this.io.store.listVersions(runId)).reduce((m, x) => Math.max(m, x.n), 0);
    if (v.status === "locked") throw new SignoffError(409, "locked", `Version ${n} is locked; edits make a new version`);
    if (v.status === "rejected") throw new SignoffError(409, "rejected", `Version ${n} was already rejected`);
    if (v.n !== latest) throw new SignoffError(409, "superseded", `Version ${n} was replaced by version ${latest}`);
    if (loaded.model === undefined) throw new SignoffError(422, "invalid_logic_model", "The version is not a valid logic model", { issues: loaded.issues });
    Signoff.checkBytes(loaded);
    if (req.modelSha !== loaded.sha) {
      throw new SignoffError(409, "sha_mismatch", "The version's content is not what you reviewed; reload it and review again", { modelSha: loaded.sha });
    }
    const officer = validSignatures(v.signatures, loaded.sha, v)[0];
    if (officer === undefined) throw new SignoffError(409, "officer_signature_required", "The program officer signs first; the clinician reviews after that (AR-03)");
    if (sameUser(officer.userId, userId)) throw new SignoffError(403, "separation_of_duties", "The program officer who signed cannot reject as the clinician");
    if (run.state !== "awaiting_clinician") {
      throw new SignoffError(409, "wrong_state", `The run is in state ${run.state}; the clinician rejects in state awaiting_clinician`, { runState: run.state });
    }
    const rejection: Rejection = {
      role: "clinician",
      userId,
      modelSha: loaded.sha,
      comment,
      ...(req.itemRef !== undefined ? { itemRef: req.itemRef } : {}),
      urgent: req.urgent ?? false,
      rejectedAt: this.io.now(),
    };
    try {
      await this.io.store.rejectVersion(runId, n, rejection);
    } catch (e) {
      if (e instanceof Conflict) throw new SignoffError(409, "conflict", "The version changed while rejecting; reload and try again");
      throw e;
    }
    await this.io.store.addComment({ runId, n, itemRef: req.itemRef ?? `version:${n}`, author: userId, text: comment, createdAt: rejection.rejectedAt });
    await this.io.store.appendAudit(runId, { at: rejection.rejectedAt, type: "version_rejected", detail: { n, userId, modelSha: loaded.sha, itemRef: rejection.itemRef ?? null, urgent: rejection.urgent } });
    let runState: RunState = run.state;
    try {
      await this.transition(runId, "awaiting_clinician", "checking");
      await this.transition(runId, "checking", "awaiting_officer");
      runState = "awaiting_officer";
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      runState = (await this.mustRun(runId)).state;
    }
    return { rejection, status: "rejected", runState };
  }

  /**
   * After a version is saved: run the checks and move the run back to awaiting_officer through checking
   * (from any review state, locked included). A run that another worker holds, or that is still in the
   * pipeline, keeps its state; the findings are stored anyway (and recomputed on demand if this fails).
   */
  async onVersionSaved(runId: string, n: number): Promise<void> {
    const owner = `signoff-${randomUUID()}`;
    const held = await this.io.store.acquireLease(runId, owner, this.leaseMs, this.io.now());
    let moved = false;
    try {
      const run = await this.mustRun(runId);
      if (held && REVIEW_STATES.includes(run.state)) {
        await this.transition(run.runId, run.state, "checking");
        moved = true;
      }
      await computeFindings(this.io, runId, n);
      if (moved) await this.transition(runId, "checking", "awaiting_officer");
    } catch (e) {
      if (moved) {
        try {
          await this.transition(runId, "checking", "failed", { currentStep: "checks" });
        } catch {
          // Best effort; the original error is rethrown.
        }
      }
      throw e;
    } finally {
      if (held) await this.io.store.releaseLease(runId, owner);
    }
  }

  /**
   * The release guard (AR-08, AR-09; DEC-019, DEC-020). Refuses unless ALL hold:
   * - version n is locked with the program officer's then the clinician's signature on its current content,
   *   by two different people, both given with exactly the settings of this build (settingsSha);
   * - it is the newest locked version of the run (AR-09: an older locked version can never be released;
   *   a newer unsigned or rejected draft does not block);
   * - its stored bytes are the ones recorded at save (bodySha256), so no field outside modelSha changed;
   * - the checks, run NOW with the build settings and the run's golden cases (never read from the store),
   *   allow a build.
   */
  async verifyLocked(runId: string, n: number, opts: { settings: CompileSettings }): Promise<LockedVersion> {
    if (opts === undefined || opts.settings === undefined) throw new SignoffError(422, "settings_required", "A release build needs its compile settings");
    await this.mustRun(runId);
    const settingsSha = settingsShaOf(opts.settings);
    const runInputs = await inputsFor(this.io, runId);
    const inputs: CheckInputs = { ...runInputs, compileSettings: opts.settings };
    const { record, loaded } = await this.fresh(runId, n, inputs);
    const check = verifyLock(loaded.sha, loaded.version, { settingsSha });
    if (!check.ok) {
      const code = /other compile settings/.test(check.reason) ? "settings_mismatch" : "not_locked";
      throw new SignoffError(409, code, check.reason);
    }
    const versions = await this.io.store.listVersions(runId);
    const newestLocked = versions.filter((x) => x.status === "locked").reduce((m, x) => Math.max(m, x.n), 0);
    if (newestLocked !== n) {
      throw new SignoffError(409, "not_latest_locked", `version ${n} is not the most recent signed version (version ${newestLocked} is); only that one can be released (AR-09)`);
    }
    if (loaded.version.bodySha256 === undefined) {
      throw new SignoffError(409, "body_unsealed", `version ${n} has no record of its stored bytes; save it again as a new version and sign that`);
    }
    Signoff.checkBytes(loaded);
    if (loaded.model === undefined) throw new SignoffError(422, "invalid_logic_model", "The locked version does not parse");
    if (!record.gates.canCompile) throw new SignoffError(422, "blocked", `The form cannot be built: ${record.gates.summary}`);
    return { model: loaded.model, sha: loaded.sha, version: loaded.version, findings: record, settingsSha, inputs };
  }

  private async transition(runId: string, from: RunState, to: RunState, extra: Partial<Run> = {}): Promise<void> {
    if (!canTransition(from, to)) throw new Error(`Illegal transition for ${runId}: ${from} -> ${to}`);
    await this.io.store.updateRun(runId, { ...extra, state: to }, from);
    await this.io.store.appendAudit(runId, { at: this.io.now(), type: "run_state", detail: { from, to } });
  }

  /** The signature is already stored; a concurrent save may have moved the run on, which is fine. */
  private async tryTransition(runId: string, from: RunState, to: RunState): Promise<RunState> {
    try {
      await this.transition(runId, from, to);
      return to;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      return (await this.mustRun(runId)).state;
    }
  }
}

function nextStep(status: ApprovalStatus, rec: FindingsRecord): string {
  switch (status) {
    case "locked":
      return "Locked: both have signed. The form can be built from this version.";
    case "superseded":
      return "Replaced by a newer version: review and sign the newest version instead.";
    case "invalid":
      return "The signatures no longer match the content of this version. It cannot be built.";
    case "rejected":
      return "Rejected by the clinician with a comment. The program officer makes the fix as a new version; this one is kept but can never be signed or built.";
    case "awaiting_officer":
      return rec.gates.canOfficerSign ? "Waiting for the program officer's signature." : `Waiting for fixes before the program officer can sign. ${rec.gates.summary}`;
    case "awaiting_clinician":
      return rec.gates.canClinicianSign ? "Waiting for the clinician's signature." : `Waiting for the clinician to settle their items. ${rec.gates.summary}`;
  }
}
