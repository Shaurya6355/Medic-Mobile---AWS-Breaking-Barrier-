/* Pathway spec: the logic model JSON (schema_version 1.0). One file per pathway version.
   Produced by the logic model step (placeholder today, AgentCore later), validated by analyze.ts,
   edited in the review UI, compiled to a flow graph and XLSForm. Pure data: must survive JSON round-trips. */

export type Origin = "guideline" | "team";
export type AnswerType = "yes_no" | "integer";
export type Op = "is_yes" | "is_no" | "at_least" | "at_most" | "less_than" | "greater_than" | "equals";
export const BOOL_OPS: Op[] = ["is_yes", "is_no"];
export const NUM_OPS: Op[] = ["at_least", "at_most", "less_than", "greater_than", "equals"];

/** A condition. Leaves compare one field (question or derived value); groups combine. */
export type Leaf = { field: string; op: Op; value?: number };
export type Cond = Leaf | { all: Cond[] } | { any: Cond[] } | { not: Cond };

export interface Source { page: number; quote: string }

export interface Constraint { min?: number; max?: number; message?: string; origin?: Origin }
export interface Question {
  id: string; order: number; label: string; answer_type: AnswerType; unit?: string; required: boolean;
  constraint?: Constraint;
  /** Hidden (and unanswered) unless this holds. May only use earlier questions. */
  shown_when?: Cond;
  origin: Origin; source?: Source;
}
export interface Derived { id: string; label: string; definition: Cond; origin: Origin; source?: Source }

export interface DoseRow { age_months_min: number; age_months_below: number; dose: string; total?: string }
export interface Action { text: string; dose_by_age?: DoseRow[]; origin: Origin; source?: Source }
export interface FollowUp {
  kind: "scheduled" | "on_return"; due_in_days: number | null; task_window_days_after_due: number | null;
  origin: Origin; source?: Source;
}
export interface Outcome {
  id: string; severity: number; title: string; actions: Action[]; follow_up: FollowUp | null;
  origin: Origin; source?: Source;
}
export interface Rule { id: string; priority: number; when: Cond | "otherwise"; outcome: string; origin: Origin; source?: Source }
export interface OpenQuestion {
  id: string; question: string; affects: string[]; route_to: "clinician" | "program_officer";
  status: "open" | "resolved"; source?: Source;
}

export interface Spec {
  schema_version: "1.0";
  meta: {
    pathway_id: string; version: number; parent_version: number | null; created_at: string; created_by: string; change_note: string;
    guideline: { title: string; publisher: string; edition: string; file_sha256: string };
  };
  scope: { age_months_min: number; age_months_below: number; source?: Source; excluded: { item: string; reason: string }[] };
  questions: Question[];
  derived: Derived[];
  outcomes: Outcome[];
  hit_policy: "first_match_by_priority";
  rules: Rule[];
  open_questions: OpenQuestion[];
}

/** Answers to the form. Yes/no as boolean, integers as number, null when hidden or unanswered. */
export type Answers = Record<string, boolean | number | null>;

/** Stable ids for the reviewable parts of a spec. Shared by the UI, flags, reviews and diagnostics. */
export type ItemId = string;
export const item = {
  scope: "scope",
  q: (id: string) => "q:" + id,
  d: (id: string) => "d:" + id,
  rule: (id: string) => "rule:" + id,
  out: (id: string) => "out:" + id,
  fu: (outcomeId: string) => "fu:" + outcomeId,
};
export function splitItem(id: ItemId): [kind: "scope" | "q" | "d" | "rule" | "out" | "fu" | "other", key: string] {
  if (id === "scope") return ["scope", ""];
  const i = id.indexOf(":");
  const k = id.slice(0, i);
  return (["q", "d", "rule", "out", "fu"].includes(k) ? [k, id.slice(i + 1)] : ["other", id]) as [never, string];
}
