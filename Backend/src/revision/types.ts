/**
 * Shared types of the revision loop (comment -> AI instruction -> confirmed -> AI edit proposal ->
 * code applies -> new version). This file is the contract between the engine (engine.ts, apply.ts,
 * proposal.ts, prompts) and the service/API (service.ts, api routes). Change it only together.
 *
 * Design rules (BRD GR-01, GR-03, GR-04, GR-11; claude.md design rules 1, 3, 7):
 *  - the model never writes a number, operator, quote, page, hash or clinical text: it names edits
 *    by id / extraction id / threshold index, and code copies the content from the extraction;
 *  - an edit may only touch items the confirmed comments point at;
 *  - a row decided by the clinician (origin "clinician") is never changed silently: it is refused and listed;
 *  - what the model cannot ground becomes an open question, never an invented value;
 *  - the result is a new version (zero signatures) that takes the same path and checks as any hand edit.
 */

export type RevisionRole = "program_officer" | "clinician";

/** One piece of feedback. `source: "comment"` is a stored Comment, `"rejection"` the text of a rejection. */
export interface RevisionComment {
  /** Item the comment is about: "rules.R3", "outcomes.refer_urgent", "questions.cough_days", "derived.fast_breathing", "open_questions.Q2". */
  itemRef: string;
  text: string;
  author: string;
  source: "comment" | "rejection";
  createdAt: number;
}

/** Step 1 output: what the model understood, in plain words, shown to the person before anything changes. */
export interface InstructionNote {
  itemRef: string;
  /** The model's reading of this comment, one sentence. */
  understood: string;
  /** "extraction_supported": the booklet extraction has what is needed. "needs_human": it does not (becomes an open question). */
  feasible: "extraction_supported" | "needs_human";
}

/** The edits the model may propose. All content is copied by code from the extraction or the current model. */
export type EditOp =
  | { op: "set_threshold"; owner: string; path: number[]; threshold: number }
  | { op: "set_rule_outcome"; rule: string; outcome: string }
  | { op: "replace_action"; outcome: string; actionIndex: number; extractionId: string }
  | { op: "set_follow_up"; outcome: string; followupId: string | null };

export interface Proposal {
  edits: EditOp[];
  /**
   * Things the comments ask for that no edit above can express safely; code turns each into an open question
   * whose TEXT IS BUILT BY CODE from the itemRef and a fixed phrase per reason (the model writes no free text).
   * Severity is deliberately not editable here (owned by someone else); a request about it goes here as "needs_clinical_decision".
   */
  unsupported: { itemRef: string; reason: "not_in_extraction" | "needs_clinical_decision" | "ambiguous" | "other" }[];
}

export interface AppliedEdit {
  edit: EditOp;
  /** Plain-language line for the reviewer, written by code. */
  summary: string;
}
export interface RefusedEdit {
  edit: EditOp;
  reason: "outside_comment_scope" | "clinician_decided" | "unknown_target" | "not_grounded" | "invalid_result";
  detail: string;
}

export type RevisionStatus =
  | "instruction_ready" // step 1 done, waiting for the person to confirm (or edit) the instruction
  | "applying" // confirmed; step 2 runs in the background (the client polls GET revision). Stale after APPLYING_STALE_MS => reported as failed
  | "applied" // step 2 done, a new version was saved
  | "no_change" // step 2 done, nothing could be applied; no version saved (see refused / questionsAdded)
  | "failed"; // a model or system error; nothing saved; may be confirmed again

export interface RevisionUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  modelId?: string;
  latencyMs?: number;
}

/** Stored as the artifact runs/<runId>/revisions/<id>.json (no new table). */
export interface Revision {
  id: string;
  runId: string;
  fromVersion: number;
  toVersion?: number;
  requestedBy: { userId: string; role: RevisionRole };
  comments: RevisionComment[];
  /** Step 1: the model's instruction text and its reading of each comment. */
  instruction: string;
  notes: InstructionNote[];
  /** Step 2: the instruction as confirmed (possibly edited) and by whom. */
  confirmedInstruction?: string;
  confirmedBy?: { userId: string; role: RevisionRole };
  /** Set when step 2 was dispatched (ms since epoch); used to detect a stale `applying`. */
  applyingSince?: number;
  proposal?: Proposal;
  applied: AppliedEdit[];
  refused: RefusedEdit[];
  /** Open questions added by code (code-built questions: unsupported asks, a removed follow-up, a medicine step whose quote does not name the medicine). */
  questionsAdded: string[];
  status: RevisionStatus;
  error?: string;
  /** One entry per model call (instruction call, then proposal call). */
  usage: RevisionUsage[];
  createdAt: number;
  updatedAt: number;
}

/**
 * An `applying` revision older than this with no result is reported as `failed` (the worker died), so the person can confirm again.
 * Must be longer than DEFAULT_REVISION_LEASE_MS (12 min, service.ts): a worker may legitimately hold the run lease that long, and a
 * confirm before the lease ends would answer 409 `busy`.
 */
export const APPLYING_STALE_MS = 13 * 60 * 1000;

export const revisionKey = (runId: string, id: string): string => `runs/${runId}/revisions/${id}.json`;
