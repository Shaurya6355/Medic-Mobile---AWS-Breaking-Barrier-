/* Workflow types. The logic model itself is the pathway spec (shared/pathway/types.ts), the same JSON the
   backend pipeline produces. Everything here must survive JSON round-trips (stored by the backend later). */
import type { Answers, ItemId, Page, Patch, Spec } from "../../../shared/pathway/index.ts";

export type { Answers, ItemId, Patch, Spec };
/** The logic model under review: a pathway spec. */
export type Model = Spec;
export type Role = "clinician" | "it";

export interface Patient { id: string; answers: Answers }
export interface Classification { out: string | null; rule: string | null }

export type Severity = "blocking" | "warning";
export type CheckKey = "schema" | "quote" | "number" | "logic" | "golden" | "cross";
export interface Check { sev: Severity; id: ItemId; text: string; kind?: CheckKey }
/** What the checks compare the draft against. */
export interface Evidence {
  /** Guideline text by page, for the quote check. Null when not loaded. */
  pages: Page[] | null; pagesFrom: string;
  /** Draft B for the cross check. Null when the pipeline gave none. */
  draftB: Spec | null; draftBFrom: string;
}

/** An open question from the logic model, put to the clinician by the AI agent. */
export interface Flag {
  id: string; about: ItemId; title: string; src: string; why: string;
  res?: { choice: "keep" | "change"; note: string; by: string };
}

/** A change the assistant proposes; applied only when the clinician clicks Apply. */
export interface Proposal { label: string; item: ItemId; field: string; patch: Patch; impact: string; state: "open" | "applied" | "dismissed" }
export interface ChatMsg {
  id: number; from: "agent" | "clinician"; text: string;
  /** Step to show on the flow. */
  select?: ItemId;
  proposals?: Proposal[];
  /** An open question the clinician answers from the chat. */
  ask?: string;
}
/** Something the AI agent fixed or checked on its own, before the clinician sees the draft. */
export interface AgentFix { item: ItemId; check: CheckKey; text: string }

export type WfState = "none" | "clinician" | "verify" | "deploy" | "done";

export interface AuditRow { t: string; actor: string; event: string; ver: string; hash: string; note: string }
export interface VersionRow { ver: string; event: string; meta: string }
export interface VerifyResult { match: number; total: number; cov: number; covTotal: number; tasks: number; mut: number; mutTotal: number }

/** A finding from the backend's checks (GET /runs/:id/versions/:n/findings), worded for one role. */
export interface RemoteFinding { severity: "blocking" | "warning" | "info"; message: string; check: string; role: "program_officer" | "clinician" }
/** Live mode: the backend run and version this workflow was loaded from. */
export interface Remote { runId: string; n: number; modelSha: string; base: Model; claimText: string; findings: RemoteFinding[] }

export interface Workflow {
  id: string;
  guideline: { id: string; name: string; pathway: string; pages: number[] } | null;
  state: WfState;
  rev: number;
  model: Model;
  evidence: Evidence;
  /** The logic model as the AI agent handed it over, before any clinician edit. "Edited" markers compare against it. */
  draft: Model;
  flags: Flag[];
  chat: ChatMsg[];
  agent: AgentFix[];
  /** Models before each clinician edit, newest last. */
  undo: Model[];
  audit: AuditRow[];
  versions: VersionRow[];
  clock: number;
  verify: VerifyResult | null;
  approved: { ver: string; hash: string; locked?: { n: number; modelSha: string } } | null;
  lastKey: string | null;
  /** Set in live mode only. */
  remote: Remote | null;
}

export type GuidelineType = "PDF" | "Word" | "Spreadsheet" | "Image" | "Web or text" | "Other";
export type GuidelineStatus = "Uploading" | "Processing" | "Indexed" | "Uploaded" | "Unsupported" | "Failed";
/** One step of the intake pipeline: upload, S3 event, extract, digest, logic model. Set by the backend. */
export interface PipelineStep { key: string; label: string; state: "pending" | "running" | "done" | "failed"; startedAt?: string; endedAt?: string; detail?: string }
export interface Guideline {
  id: string; name: string; type: GuidelineType; meta: string; status: GuidelineStatus; pages: number | null;
  /** Present only for files that went through the backend pipeline. */
  steps?: PipelineStep[];
  error?: string;
  s3Uri?: string;
}
