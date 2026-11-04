import { collectFieldRefs } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeDerived, describeRule, questionSubject } from "../describe.js";
import { citation } from "./common.js";

export const CHECK = "requiredQuestions";

/**
 * Required questions. Every question read by any rule or calculated value must be required (so that it
 * cannot be skipped): a skipped answer is treated as normal, which would send an unmeasured child down the
 * "nothing found" path. Also lists, for information, the counted or measured number questions that give no
 * way to record "could not measure" (the age question, in months, is not a measurement and is left out).
 */
export function requiredQuestions(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const readers = new Map<string, string[]>();
  const note = (id: string, who: string): void => {
    const l = readers.get(id) ?? [];
    if (!l.includes(who)) l.push(who);
    readers.set(id, l);
  };
  for (const d of model.derived) for (const f of collectFieldRefs(d.definition)) note(f, describeDerived(d));
  for (const r of model.rules) if (r.when !== "otherwise") for (const f of collectFieldRefs(r.when)) note(f, describeRule(model, r).split(",")[0] as string);
  const out: Finding[] = [];
  const measured: typeof model.questions = [];
  for (const q of model.questions) {
    const who = readers.get(q.id);
    if (who === undefined) continue;
    if (!q.required) {
      const c = citation(q);
      out.push(
        makeFinding({
          check: CHECK,
          code: "REQUIRED_QUESTION_OPTIONAL",
          severity: "blocking",
          audience: ["clinician", "program_officer"],
          decidedBy: "clinician",
          subjects: [questionSubject(q)],
          params: { question: q.label, item: `used by ${who.slice(0, 3).join(", ")}${who.length > 3 ? " and others" : ""}`, ...c.params },
          source: c.source,
        }),
      );
    }
    if (q.answer_type === "integer" && q.unit !== "months") measured.push(q);
  }
  if (measured.length > 0) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "UNMEASURABLE_NOT_SUPPORTED",
        severity: "info",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: measured.map(questionSubject),
        params: { questions: measured.map((q) => q.label).join("; ") },
        source: [],
      }),
    );
  }
  return out;
}
