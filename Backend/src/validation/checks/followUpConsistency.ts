import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeFollowUp, describeOutcome, followUpSubject, outcomeSubject } from "../describe.js";
import { citation } from "./common.js";
import { dangerOutcomeIds } from "./dangerSigns.js";

export const CHECK = "followUpConsistency";

/** A referral is an outcome whose title or any action text contains "refer" (any case). */
export function isReferral(o: { title: string; actions: readonly { text: string }[] }): boolean {
  return /refer/i.test(o.title) || o.actions.some((a) => /refer/i.test(a.text));
}

const FOLLOW_UP = /follow[\s-]*up/i;
const FIXED_DAYS = /\b(?:in|after|within)\s+(\d+)\s+days?\b/i;

type Outcome = CheckContext["model"]["outcomes"][number];
type Said = { where: string; says: string; page?: number; quote?: string };

/** The passages of a result that mention a follow-up: its title, its actions' text, and the booklet quotes it and its actions cite. */
function followUpMentions(o: Outcome): Said[] {
  const out: Said[] = [];
  const one = (t: string): string => t.replace(/\s+/g, " ").trim();
  if (FOLLOW_UP.test(o.title)) out.push({ where: "its title", says: one(o.title) });
  for (const a of o.actions) if (FOLLOW_UP.test(a.text)) out.push({ where: "one of its instructions", says: one(a.text) });
  for (const s of [...(o.source ?? []), ...o.actions.flatMap((a) => a.source ?? [])]) {
    if (FOLLOW_UP.test(s.quote)) out.push({ where: "the booklet passage it cites", says: one(s.quote), page: s.page, quote: one(s.quote) });
  }
  return out;
}

/**
 * Follow-ups hold together:
 *  - a referral without any follow-up blocks. A referral is a result whose title or an action says "refer", or
 *    any result a danger sign leads to (decided from the rules, see dangerSigns.ts), whatever its wording;
 *  - a result without a follow-up whose title, instructions or cited booklet passages say to follow up blocks
 *    (FOLLOWUP_REQUIRED_BY_SOURCE);
 *  - a scheduled follow-up has no negative day count or task window, and is not due after 0 days (the same day);
 *    a missing day count or window is for the compile check;
 *  - a follow-up on return whose own passage, or the result's title, gives a fixed number of days ("in 3 days")
 *    blocks (FOLLOWUP_KIND_MISMATCH): no reminder would be created; on return with days carried is noted.
 */
export function followUpConsistency(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const both = ["clinician", "program_officer"] as ("clinician" | "program_officer")[];
  const danger = dangerOutcomeIds(ctx.model, ctx.extraction);
  for (const o of ctx.model.outcomes) {
    const f = o.follow_up;
    if (f === null) {
      if (isReferral(o) || danger.has(o.id)) {
        out.push(
          makeFinding({
            check: CHECK,
            code: "FOLLOWUP_MISSING_OUTCOME",
            severity: "blocking",
            audience: both,
            decidedBy: "clinician",
            subjects: [outcomeSubject(o)],
            params: { item: describeOutcome(o), ...citation(o).params },
            source: citation(o).source,
          }),
        );
        continue;
      }
      const said = followUpMentions(o)[0];
      if (said !== undefined) {
        const page: Record<string, string> = said.page === undefined ? {} : { page: String(said.page), quote: said.quote ?? "" };
        out.push(
          makeFinding({
            check: CHECK,
            code: "FOLLOWUP_REQUIRED_BY_SOURCE",
            severity: "blocking",
            audience: both,
            decidedBy: "clinician",
            subjects: [outcomeSubject(o)],
            params: { item: describeOutcome(o), where: said.where, says: said.says, ...page },
            source: said.page === undefined ? [] : [{ page: said.page, quote: said.quote ?? "" }],
          }),
        );
      }
      continue;
    }
    const cite = citation(f);
    const common = { check: CHECK, audience: both, decidedBy: "clinician" as const, subjects: [followUpSubject(o)], source: cite.source };
    if (f.kind === "scheduled") {
      for (const [v, what] of [[f.due_in_days, "a follow-up due after"], [f.task_window_days_after_due, "a task that stays open for"]] as const) {
        if (v !== null && v < 0) {
          out.push(makeFinding({ ...common, code: "FOLLOWUP_INVALID_DAYS", severity: "blocking", params: { item: describeFollowUp(o), what, value: v, ...cite.params } }));
        }
      }
      if (f.due_in_days === 0) {
        out.push(makeFinding({ ...common, code: "FOLLOWUP_DUE_SAME_DAY", severity: "blocking", params: { item: describeFollowUp(o), ...cite.params } }));
      }
      continue;
    }
    const fixed =
      (f.source ?? []).map((x) => ({ where: "its booklet passage", says: x.quote.replace(/\s+/g, " ").trim() })).find((x) => FIXED_DAYS.test(x.says)) ??
      (FIXED_DAYS.test(o.title) ? { where: "the title of the result", says: o.title.replace(/\s+/g, " ").trim() } : undefined);
    if (fixed !== undefined) {
      out.push(makeFinding({ ...common, code: "FOLLOWUP_KIND_MISMATCH", severity: "blocking", params: { item: describeFollowUp(o), where: fixed.where, says: fixed.says, ...cite.params } }));
    }
    if (f.due_in_days !== null) {
      out.push(makeFinding({ ...common, code: "FOLLOWUP_RETURN_DAYS_IGNORED", severity: "info", params: { item: describeFollowUp(o), days: f.due_in_days, ...cite.params } }));
    }
  }
  return out;
}
