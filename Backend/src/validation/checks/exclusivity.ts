import { BOTH, makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeChild, exampleOf } from "../child.js";
import { describeRule, ruleSubject } from "../describe.js";
import { citation, provenAnalysis } from "./common.js";

export const CHECK = "exclusivity";

/**
 * Exclusivity under the first-match policy: a rule that applies to some child but is never the first to
 * apply is shadowed (wholly hidden by the rules checked before it). The catch-all is not reported:
 * when it never decides, the rules above already cover everyone, which is harmless.
 */
export function exclusivity(ctx: CheckContext): Finding[] {
  const a = provenAnalysis(ctx);
  if (a?.rules === undefined) return [];
  const out: Finding[] = [];
  for (const r of ctx.model.rules) {
    if (r.when === "otherwise") continue;
    const stat = a.rules.perRule[r.id];
    const sh = a.shadow.get(r.id);
    if (stat === undefined || stat.first > 0 || sh === undefined) continue;
    const c = citation(r);
    out.push(
      makeFinding({
        check: CHECK,
        code: "SHADOWED_RULE",
        severity: "warning",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [ruleSubject(r)],
        params: { item: describeRule(ctx.model, r), winner: sh.winner, child: describeChild(ctx.model, sh.example), ...c.params },
        source: c.source,
        example: exampleOf(sh.example),
      }),
    );
  }
  return out;
}
