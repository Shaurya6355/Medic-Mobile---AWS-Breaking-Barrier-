import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeOutcome, describeQuestion, describeRule, derivedSubject, outcomeSubject, questionSubject, ruleSubject } from "../describe.js";
import { citation, provenAnalysis } from "./common.js";
import { thresholdsOutsideLimits } from "../../logic/grid.js";
import type { Model } from "../../logic/schema.js";
import type { Subject } from "../finding.js";
import { describeDerived } from "../describe.js";

export const CHECK = "reachability";

/**
 * Reachability over the exact grid:
 *  - every rule (except the catch-all) is the first to apply for at least one combination, else UNREACHABLE_RULE;
 *  - every result is given for at least one combination, else UNREACHABLE_OUTCOME. This also covers the
 *    follow-up of the result: a follow-up is only set up through its result, so if the result can come up, so can it;
 *  - every question with a condition for being asked is asked for at least one combination;
 *  - every calculated value is yes for some combination and no for another, else DERIVED_CONSTANT;
 *  - every cut-off on a whole-number question can be reached from both sides within the entry limits, else
 *    ENTRY_LIMIT_HIDES_CUTOFF (blocking): with breaths limited to 45, "50 breaths or more" can never be recorded.
 *    This part does not need the combinations, so it runs even when they could not all be gone through.
 */
export function reachability(ctx: CheckContext): Finding[] {
  const out: Finding[] = entryLimits(ctx.model);
  const a = provenAnalysis(ctx);
  if (a?.rules === undefined) return out;
  const model = ctx.model;
  for (const r of model.rules) {
    if (r.when === "otherwise") continue;
    const stat = a.rules.perRule[r.id];
    if (stat === undefined || stat.first > 0) continue;
    const c = citation(r);
    out.push(
      makeFinding({
        check: CHECK,
        code: "UNREACHABLE_RULE",
        severity: "blocking",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [ruleSubject(r)],
        params: { item: describeRule(model, r), why: stat.matched > 0 ? "hidden" : "never", winner: a.shadow.get(r.id)?.winner ?? "", ...c.params },
        source: c.source,
      }),
    );
  }
  for (const o of model.outcomes) {
    if ((a.rules.perOutcome[o.id] ?? 0) > 0) continue;
    const c = citation(o);
    out.push(
      makeFinding({
        check: CHECK,
        code: "UNREACHABLE_OUTCOME",
        severity: "blocking",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [outcomeSubject(o)],
        params: { outcome: o.title, item: describeOutcome(o), hasFollowUp: o.follow_up !== null, ...c.params },
        source: c.source,
      }),
    );
  }
  for (const q of model.questions) {
    if (q.shown_when === undefined || (a.shown.get(q.id) ?? 0) > 0) continue;
    const c = citation(q);
    out.push(
      makeFinding({
        check: CHECK,
        code: "QUESTION_NEVER_SHOWN",
        severity: "blocking",
        audience: ["program_officer", "clinician"],
        decidedBy: "program_officer",
        subjects: [questionSubject(q)],
        params: { question: q.label, item: describeQuestion(q), ...c.params },
        source: c.source,
      }),
    );
  }
  for (const d of model.derived) {
    const seen = a.derivedSeen.get(d.id);
    if (seen === undefined || (seen.yes > 0 && seen.no > 0)) continue;
    const c = citation(d);
    out.push(
      makeFinding({
        check: CHECK,
        code: "DERIVED_CONSTANT",
        severity: "warning",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [derivedSubject(d)],
        params: { item: d.label, always: seen.yes > 0 ? "yes" : "no", ...c.params },
        source: c.source,
      }),
    );
  }
  return out;
}

function entryLimits(model: Model): Finding[] {
  const out: Finding[] = [];
  for (const x of thresholdsOutsideLimits(model)) {
    const q = model.questions.find((y) => y.id === x.question);
    if (q?.constraint === undefined) continue;
    const [kind, id] = x.where.split(":") as [string, string];
    let subject: Subject;
    let item: string;
    let src: Parameters<typeof citation>[0];
    if (kind === "derived") {
      const d = model.derived.find((y) => y.id === id)!;
      subject = derivedSubject(d);
      item = describeDerived(d);
      src = d;
    } else if (kind === "rule") {
      const r = model.rules.find((y) => y.id === id)!;
      subject = ruleSubject(r);
      item = describeRule(model, r);
      src = r;
    } else {
      const w = model.questions.find((y) => y.id === id)!;
      subject = questionSubject(w);
      item = `the condition for asking ${describeQuestion(w)}`;
      src = w;
    }
    const c = citation(src);
    const above = Math.ceil(x.value) > q.constraint.max;
    out.push(
      makeFinding({
        check: CHECK,
        code: "ENTRY_LIMIT_HIDES_CUTOFF",
        severity: "blocking",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: subject.kind === "question" && subject.id === q.id ? [subject] : [subject, questionSubject(q)],
        params: {
          item,
          question: q.label,
          value: x.value,
          unit: q.unit === undefined ? "" : ` ${q.unit.replace(/_/g, " ")}`,
          min: q.constraint.min,
          max: q.constraint.max,
          effect: above
            ? "no child can be recorded at or above the cut-off and the children it is meant to pick out can never be found"
            : "every child that can be entered is already at or above the cut-off, so it never separates children",
          ...c.params,
        },
        source: c.source,
      }),
    );
  }
  return out;
}
