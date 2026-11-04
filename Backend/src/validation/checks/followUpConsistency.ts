import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeFollowUp, describeOutcome, followUpSubject, outcomeSubject } from "../describe.js";
import { citation } from "./common.js";

export const CHECK = "followUpConsistency";

/** A referral is an outcome whose title or any action text contains "refer" (any case). */
export function isReferral(o: { title: string; actions: readonly { text: string }[] }): boolean {
  return /refer/i.test(o.title) || o.actions.some((a) => /refer/i.test(a.text));
}

/**
 * Follow-ups hold together: a scheduled one has no negative day count or task window (a missing one is
 * for the compile check), a follow-up on return that also carries days is noted, and a referral without
 * any follow-up blocks.
 */
export function followUpConsistency(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const o of ctx.model.outcomes) {
    const f = o.follow_up;
    if (f === null) {
      if (isReferral(o)) {
        out.push(
          makeFinding({
            check: CHECK,
            code: "FOLLOWUP_MISSING_OUTCOME",
            severity: "blocking",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects: [outcomeSubject(o)],
            params: { item: describeOutcome(o), ...citation(o).params },
            source: citation(o).source,
          }),
        );
      }
      continue;
    }
    const cite = citation(f);
    const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const, subjects: [followUpSubject(o)], source: cite.source };
    if (f.kind === "scheduled") {
      for (const [v, what] of [[f.due_in_days, "a follow-up due after"], [f.task_window_days_after_due, "a task that stays open for"]] as const) {
        if (v !== null && v < 0) {
          out.push(makeFinding({ ...common, code: "FOLLOWUP_INVALID_DAYS", severity: "blocking", params: { item: describeFollowUp(o), what, value: v, ...cite.params } }));
        }
      }
    } else if (f.due_in_days !== null) {
      out.push(makeFinding({ ...common, code: "FOLLOWUP_RETURN_DAYS_IGNORED", severity: "info", params: { item: describeFollowUp(o), days: f.due_in_days, ...cite.params } }));
    }
  }
  return out;
}
