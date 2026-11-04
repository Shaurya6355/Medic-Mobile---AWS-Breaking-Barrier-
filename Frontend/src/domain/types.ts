/* Logic model and workflow types. Pure data: everything here must survive JSON round-trips,
   because the same shapes are stored by the backend (pathway.json, DynamoDB rows). */

export type CondKey = "ci" | "stridor" | "fast";
export type SignKey = "drink" | "vomit" | "conv" | "leth";
export type OutKey = "o1" | "o2" | "o3";
export type NodeId = "start" | "d1" | "d2" | "d3" | "o1" | "o2" | "o3" | "f1";
/** A flow node id, or "q:<questionId>" for a question. */
export type ItemId = string;
export type QType = "yesno" | "int" | "multi";
export type Role = "po" | "clinician" | "it";

export interface Question { type: QType; label: string; showIf: string; quote: string }
export interface Outcome { title: string; note: string }

export interface Model {
  start: { ageMin: number; ageMax: number };
  d1: { q: string; signs: SignKey[] };
  d2: { q: string; conds: CondKey[]; hint: string };
  d3: { q: string; conds: CondKey[]; cut: number; young: number; old: number; hint: string };
  o1: Outcome; o2: Outcome; o3: Outcome;
  f1: { title: string; due: number; end: number };
  /** [verbatim quote, location in the guideline] */
  src: Record<NodeId, [string, string]>;
  questions: Record<string, Question>;
}

export interface PatientInputs { age: number; rr: number; ci: boolean; stridor: boolean; danger: SignKey[] }
export interface Patient extends PatientInputs { id: string }
export interface Classification { out: OutKey | "none"; rule: string }

export type Severity = "blocking" | "warning";
export interface Check { sev: Severity; id: ItemId; text: string }

/** A structured, schema-checkable change. Hand edits and AI revisions both become patches. */
export type Patch =
  | { op: "set"; node: NodeId; key: string; value: string | number | string[] }
  | { op: "setQ"; q: string; key: "label" | "showIf" | "quote"; value: string }
  | { op: "removeQ"; q: string }
  | { op: "addQ"; q: string; question: Question }
  | { op: "setSrc"; node: NodeId; value: [string, string] };

export type FbType = "wording" | "value" | "show" | "source" | "remove" | "add";
export interface Decision { status: "approved" | "changes"; type?: FbType; note?: string; value?: string }
export interface Review extends Decision { round: number }

export type SuggestionOutcome = "accepted" | "edited" | "discarded";
export type Suggestion =
  | { kind: "clarify"; text: string; outcome?: SuggestionOutcome }
  | { kind: "change"; field: string; from: string; to: string; patch: Patch; outcome?: SuggestionOutcome };

export interface FlagOption {
  label: string;
  fb?: { type: FbType; note: string; value: string; about?: ItemId };
  escalate?: boolean;
}
export interface Flag {
  id: string; clinical: boolean; kind: string; about: ItemId; title: string; src: string; why: string;
  opts: FlagOption[];
  res?: { choice: string; note: string; by: string; round: number };
  escalated?: boolean;
}

export type WfState = "none" | "po_draft" | "clinician" | "po_revise" | "verify" | "deploy" | "done";

export interface AuditRow { t: string; actor: string; event: string; ver: string; hash: string; note: string }
export interface VersionRow { ver: string; event: string; meta: string }
export interface VerifyResult { match: number; total: number; cov: number; tasks: number; mut: number }

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
  logicModel?: { source: "placeholder" | "agent"; builder: string; quotesFound: number; quotesTotal: number };
}
