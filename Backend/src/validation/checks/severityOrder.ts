import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeChild, exampleOf } from "../child.js";
import { ruleSubject } from "../describe.js";
import { anyAnalysis, citation, outcomeTitle } from "./common.js";

export const CHECK = "severityOrder";

/**
 * Severity order (a safety check). Where the rule that decides (the first to apply) has a LESS urgent result
 * than another rule that also applies, the child is under-triaged. Lower severity number = more urgent.
 * Each (deciding rule, hidden rule) pair is reported once, with an example child, as a blocking
 * SEVERITY_INVERSION. A clinician can approve a pair through ctx.approvedExceptions
 * ({ rules: [decidingRuleId, hiddenRuleId], by, note }); it then becomes an information finding
 * SEVERITY_EXCEPTION_APPROVED that carries who approved it and why.
 * An example found in part of the combinations is real, so this check reports even when NOT_PROVEN.
 */
export function severityOrder(ctx: CheckContext): Finding[] {
  const a = anyAnalysis(ctx);
  if (a?.rules === undefined) return [];
  const model = ctx.model;
  const out: Finding[] = [];
  for (const inv of a.rules.severityInversions) {
    const first = model.rules.find((r) => r.id === inv.firstRule);
    const hidden = model.rules.find((r) => r.id === inv.overriddenRule);
    if (first === undefined || hidden === undefined) continue;
    const openQ = model.open_questions
      .filter((q) => q.status === "open" && (q.affects.includes(first.id) || q.affects.includes(first.outcome)))
      .map((q) => q.id)
      .sort()[0];
    const example = a.inversionExamples.get(`${inv.firstRule}|${inv.overriddenRule}`) ?? inv.example;
    const c = citation(hidden);
    const approved = ctx.approvedExceptions?.find((x) => x.rules[0] === inv.firstRule && x.rules[1] === inv.overriddenRule);
    const params = {
      firstRule: inv.firstRule,
      overriddenRule: inv.overriddenRule,
      firstOutcome: outcomeTitle(model, inv.firstOutcome),
      overriddenOutcome: outcomeTitle(model, inv.overriddenOutcome),
      child: describeChild(model, example),
      openQuestion: openQ ?? "",
    };
    const subjects = [ruleSubject(first), ruleSubject(hidden)];
    const source = [...citation(first).source, ...c.source];
    out.push(
      approved === undefined
        ? makeFinding({
            check: CHECK,
            code: "SEVERITY_INVERSION",
            severity: "blocking",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects,
            params: { ...params, ...c.params },
            source,
            example: exampleOf(example),
          })
        : makeFinding({
            check: CHECK,
            code: "SEVERITY_EXCEPTION_APPROVED",
            severity: "info",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects,
            params: { ...params, by: approved.by, note: approved.note },
            source,
            example: exampleOf(example),
          }),
    );
  }
  return out;
}
