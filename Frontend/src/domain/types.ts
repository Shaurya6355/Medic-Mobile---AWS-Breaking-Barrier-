/* Workflow types. The logic model itself is the pathway spec (shared/pathway/types.ts), the same JSON the
   backend pipeline produces. Everything here must survive JSON round-trips (stored by the backend later). */
import type { Answers, ItemId, Patch, Path, Spec } from "../../../shared/pathway/index.ts";

export type { Answers, ItemId, Patch, Spec };
/** The logic model under review: a pathway spec. */
export type Model = Spec;
export type Role = "po" | "clinician" | "it";

export interface Patient { id: string; answers: Answers }
export interface Classification { out: string | null; rule: string | null }

export type Severity = "blocking" | "warning";
export interface Check { sev: Severity; id: ItemId; text: string }

export type FbType = "wording" | "value" | "logic" | "show" | "source" | "remove" | "add";
export interface Decision { status: "approved" | "changes"; type?: FbType; note?: string; value?: string }
export interface Review extends Decision { round: number }

export type SuggestionOutcome = "accepted" | "edited" | "discarded";
export type Suggestion =
  | { kind: "clarify"; text: string; outcome?: SuggestionOutcome;
      /** The field the feedback is about, so the PO can type the change and accept it. */
      target?: { label: string; path: Path; kind: string; value: string; page?: number } }
  | { kind: "change"; field: string; from: string; to: string; patch: Patch; outcome?: SuggestionOutcome };

export interface FlagOption {
  label: string;
  /** Turns the decision into a change request on `about`; the decider's note becomes the request. */
  fb?: { type?: FbType };
  escalate?: boolean;
  /** Sending on or requesting a change needs a note; keeping or agreeing does not. */
  needsNote?: boolean;
}
export interface Flag {
  id: string; clinical: boolean; kind: string; about: ItemId; title: string; src: string; why: string;
  opts: FlagOption[];
  res?: { choice: string; note: string; by: string; round: number };
  escalated?: boolean;
  /** The JSON suggested the clinician; the PO still decides whether to send it. */
  suggested?: boolean;
  /** The PO's note when sending it to the clinician. */
  poNote?: string;
}

export type WfState = "none" | "po_draft" | "clinician" | "po_revise" | "verify" | "deploy" | "done";

export interface AuditRow { t: string; actor: string; event: string; ver: string; hash: string; note: string }
export interface VersionRow { ver: string; event: string; meta: string }
export interface VerifyResult { match: number; total: number; cov: number; covTotal: number; tasks: number; mut: number; mutTotal: number }

export interface Workflow {
  id: string;
  guideline: { id: string; name: string; pathway: string; pages: number[] } | null;
  state: WfState;
  round: number;
  rev: number;
  model: Model;
  /** The logic model as first drafted, before any hand edit. "Edited" markers compare against it. */
  draft: Model;
  sent: Model | null;
  required: ItemId[];
  reviews: Record<ItemId, Review>;
  sug: Record<ItemId, Suggestion>;
  fixed: Record<ItemId, boolean>;
  flags: Flag[];
  audit: AuditRow[];
  versions: VersionRow[];
  clock: number;
  verify: VerifyResult | null;
  approved: { ver: string; hash: string; round: number } | null;
  lastKey: string | null;
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
  logicModel?: { source: "placeholder" | "agent"; builder: string; quotesFound: number; quotesTotal: number; quotesOnPage?: number };
}
