import type { Answers } from "../logic/interpreter.js";
import type { Model } from "../logic/schema.js";

const unitText = (u: string | undefined): string => (u === undefined ? "" : ` ${u.replace(/_/g, " ")}`);
const months = (n: number): string => `${n} month${n === 1 ? "" : "s"}`;

/**
 * Describes a set of answers as a child in patient terms, for findings shown to people.
 * The age question is the whole-number question measured in months; it opens the sentence.
 * Only questions that were asked appear. "Yes" answers are listed, "no" answers are summed up.
 */
export function describeChild(model: Model, answers: Answers): string {
  const age = model.questions.find((q) => q.answer_type === "integer" && q.unit === "months");
  const ageValue = age === undefined ? undefined : answers[age.id];
  const head = typeof ageValue === "number" ? `a child aged ${months(ageValue)}` : "a child";
  const yes: string[] = [];
  const numbers: string[] = [];
  let no = 0;
  for (const q of model.questions) {
    if (q === age) continue;
    const v = answers[q.id];
    if (v === undefined) continue;
    if (typeof v === "number") numbers.push(`"${q.label}" ${v}${unitText(q.unit)}`);
    else if (v) yes.push(`"${q.label}" yes`);
    else no++;
  }
  const parts = [...yes, ...numbers];
  if (no > 0) parts.push(parts.length === 0 ? "every yes-or-no question answered no" : "all other yes-or-no questions answered no");
  return parts.length === 0 ? head : `${head} (${parts.join("; ")})`;
}

/** Answers as plain scalar values for a finding's example; unanswered questions are left out. */
export function exampleOf(answers: Answers): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const k of Object.keys(answers).sort()) {
    const v = answers[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

import type { Condition } from "../logic/schema.js";

/** A condition in plain words, for findings: no symbols, questions named by their label. */
export function describeCondition(model: Model, c: Condition): string {
  if ("field" in c) {
    const q = model.questions.find((x) => x.id === c.field);
    const d = model.derived.find((x) => x.id === c.field);
    const name = q !== undefined ? `"${q.label}"` : d !== undefined ? `"${d.label}"` : c.field;
    if (c.op === "is_yes") return q !== undefined ? `${name} is answered yes` : `${name} applies`;
    const u = unitText(q?.unit);
    return c.op === "at_least" ? `${name} is ${c.value}${u} or more` : `${name} is less than ${c.value}${u}`;
  }
  const kids = "all" in c ? c.all : c.any;
  const parts = kids.map((k) => describeCondition(model, k));
  if (parts.length === 1) return parts[0] as string;
  return parts.join("all" in c ? " and " : " or ");
}
