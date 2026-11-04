import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeOutcome, outcomeSubject } from "../describe.js";
import { isReferral } from "./followUpConsistency.js";
import { citation } from "./common.js";
import { clip } from "../text.js";

export const CHECK = "clinicalText";

/**
 * Every result tells the health worker what to do (at least one action with words). A referral needs at least
 * one action taken from the booklet with a quote. Wording the team wrote itself is listed for the clinician to confirm.
 */
export function clinicalText(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const o of ctx.model.outcomes) {
    const item = describeOutcome(o);
    const cite = citation(o);
    const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const, subjects: [outcomeSubject(o)], source: cite.source };
    if (!o.actions.some((a) => a.text.trim() !== "")) {
      out.push(makeFinding({ ...common, code: "CLINICAL_TEXT_MISSING", severity: "blocking", params: { item, ...cite.params } }));
    }
    if (isReferral(o) && !o.actions.some((a) => a.origin === "guideline" && a.source !== undefined && a.source.length > 0 && a.text.trim() !== "")) {
      out.push(makeFinding({ ...common, code: "CLINICAL_TEXT_UNSOURCED", severity: "blocking", params: { item, ...cite.params } }));
    }
    const team = o.actions.filter((a) => a.origin === "team" && a.text.trim() !== "");
    if (team.length > 0) {
      out.push(
        makeFinding({
          ...common,
          audience: ["clinician"],
          source: [],
          code: "TEAM_TEXT_TO_CONFIRM",
          severity: "info",
          params: { item, texts: team.map((a) => `"${clip(a.text, 160)}"`).join("; ") },
        }),
      );
    }
  }
  return out;
}
