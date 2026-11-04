import { checkCompileReady } from "../../compiler/readiness.js";
import { OFFICER, makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeFollowUp, describeOutcome, followUpSubject } from "../describe.js";
import { citation } from "./common.js";

export const CHECK = "compileReady";

/**
 * Could the form be built from this draft and these settings? Reads the compiler's own readiness rule, so the two cannot
 * disagree. Blocking when something is missing; follow-ups for a child's return are not built (information for the
 * clinician); a task window taken from the team default is a warning. Needs ctx.compileSettings; reports nothing without it.
 */
export function compileReady(ctx: CheckContext): Finding[] {
  const settings = ctx.compileSettings;
  if (settings === undefined) return [];
  const { model } = ctx;
  const r = checkCompileReady(model, settings);
  const out: Finding[] = [];

  const openFor = (outcomeId: string): string => model.open_questions.find((q) => q.status === "open" && q.affects.includes(outcomeId))?.id ?? "";
  const outcomeById = new Map(model.outcomes.map((o) => [o.id, o]));

  const plain: string[] = [];
  let other = 0;
  for (const m of r.missing) {
    const fu = m.match(/^outcomes\.([a-z][a-z0-9_]*)\.follow_up\.(due_in_days|task_window_days_after_due)/);
    if (m.startsWith("settings.formTitle")) plain.push("the form title");
    else if (m.startsWith("settings.icon")) plain.push("the form icon");
    else if (m.startsWith("settings.contactTypes")) plain.push("who the form is for (a person or a place)");
    else if (fu !== null && outcomeById.has(fu[1] as string)) {
      const o = outcomeById.get(fu[1] as string)!;
      if (fu[2] === "due_in_days") plain.push(`the number of days until the follow-up of ${describeOutcome(o)}`);
      else {
        const q = openFor(o.id);
        plain.push(`how many days the follow-up task of ${describeOutcome(o)} stays open${q === "" ? "" : ` (open question ${q})`}`);
      }
    } else other++;
  }
  if (other > 0) plain.push(`${other} other ${other === 1 ? "problem" : "problems"} in the draft that the form builder cannot turn into a form (the other checks list them)`);
  if (plain.length > 0) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "COMPILE_NOT_READY",
        severity: "blocking",
        audience: OFFICER,
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: "form_settings" }],
        params: { missing: plain.join("; ") },
        source: [],
      }),
    );
  }

  for (const o of model.outcomes) {
    const f = o.follow_up;
    if (f === null) continue;
    const cite = citation(f);
    if (f.kind === "on_return") {
      out.push(
        makeFinding({
          check: CHECK,
          code: "FOLLOWUP_NOT_COMPILED",
          severity: "info",
          audience: ["clinician", "program_officer"],
          decidedBy: "clinician",
          subjects: [followUpSubject(o)],
          params: { item: describeFollowUp(o), ...cite.params },
          source: cite.source,
        }),
      );
    } else if (f.task_window_days_after_due === null && settings.taskWindowDays !== undefined && f.due_in_days !== null) {
      out.push(
        makeFinding({
          check: CHECK,
          code: "TEAM_DEFAULT_WINDOW",
          severity: "warning",
          audience: OFFICER,
          decidedBy: "program_officer",
          subjects: [followUpSubject(o)],
          params: { item: describeFollowUp(o), due: f.due_in_days, days: settings.taskWindowDays, openQuestion: openFor(o.id) },
          source: [],
        }),
      );
    }
  }
  return out;
}
