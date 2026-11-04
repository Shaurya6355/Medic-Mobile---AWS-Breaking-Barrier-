import type { Model, Origin } from "../logic/schema.js";
import type { Subject } from "./finding.js";
import { clip } from "./text.js";

/** Plain-language names for model items, used in finding params. */

type Question = Model["questions"][number];
type Derived = Model["derived"][number];
type Outcome = Model["outcomes"][number];
type Rule = Model["rules"][number];
type OpenQuestion = Model["open_questions"][number];

export function describeQuestion(q: Question): string {
  return `the question "${clip(q.label, 80)}"`;
}

export function describeDerived(d: Derived): string {
  return `the calculated value "${clip(d.label, 80)}"`;
}

export function describeOutcome(o: Outcome): string {
  return `the result "${clip(o.title, 80)}"`;
}

export function describeAction(o: Outcome, index: number): string {
  const a = o.actions[index];
  return `the action "${clip(a?.text ?? `${index + 1}`, 80)}" of ${describeOutcome(o)}`;
}

export function describeFollowUp(o: Outcome): string {
  return `the follow-up of ${describeOutcome(o)}`;
}

export function describeRule(model: Model, rule: Rule): string {
  const o = model.outcomes.find((x) => x.id === rule.outcome);
  return o === undefined ? `rule ${rule.id}` : `rule ${rule.id}, which gives ${describeOutcome(o)}`;
}

export function describeScope(): string {
  return "the age range the pathway covers";
}

export function describeOpenQuestion(q: OpenQuestion): string {
  return `the open question ${q.id} ("${clip(q.question, 80)}")`;
}

export const questionSubject = (q: Question): Subject => ({ kind: "question", id: q.id });
export const derivedSubject = (d: Derived): Subject => ({ kind: "derived", id: d.id });
export const outcomeSubject = (o: Outcome): Subject => ({ kind: "outcome", id: o.id });
export const actionSubject = (o: Outcome, index: number): Subject => ({ kind: "action", id: `${o.id}/action-${index + 1}` });
export const followUpSubject = (o: Outcome): Subject => ({ kind: "follow_up", id: o.id });
export const ruleSubject = (r: Rule): Subject => ({ kind: "rule", id: r.id });
export const scopeSubject: Subject = { kind: "scope", id: "scope" };
export const openQuestionSubject = (q: OpenQuestion): Subject => ({ kind: "open_question", id: q.id });

export type Cited = {
  subject: Subject;
  item: string;
  /** "guideline" or "team" as the model states it; open questions have none. */
  origin?: Origin;
  sources: readonly { page: number; quote: string }[];
};

/** Every model item that can cite the booklet, with its subject, plain-language name and sources. */
export function citedItems(model: Model): Cited[] {
  const out: Cited[] = [];
  out.push({ subject: scopeSubject, item: describeScope(), sources: model.scope.source });
  for (const q of model.questions) out.push({ subject: questionSubject(q), item: describeQuestion(q), origin: q.origin, sources: q.source ?? [] });
  for (const d of model.derived) out.push({ subject: derivedSubject(d), item: describeDerived(d), origin: d.origin, sources: d.source ?? [] });
  for (const o of model.outcomes) {
    out.push({ subject: outcomeSubject(o), item: describeOutcome(o), origin: o.origin, sources: o.source ?? [] });
    o.actions.forEach((a, i) =>
      out.push({ subject: actionSubject(o, i), item: describeAction(o, i), origin: a.origin, sources: a.source ?? [] }),
    );
    if (o.follow_up !== null) {
      out.push({ subject: followUpSubject(o), item: describeFollowUp(o), origin: o.follow_up.origin, sources: o.follow_up.source ?? [] });
    }
  }
  for (const r of model.rules) out.push({ subject: ruleSubject(r), item: describeRule(model, r), origin: r.origin, sources: r.source ?? [] });
  for (const q of model.open_questions) out.push({ subject: openQuestionSubject(q), item: describeOpenQuestion(q), sources: q.source ?? [] });
  return out;
}

/** "8" or "7 and 8" or "" for a list of cited pages. */
export function pagesText(pages: readonly number[]): string {
  return [...new Set(pages)].sort((a, b) => a - b).join(" and ");
}
