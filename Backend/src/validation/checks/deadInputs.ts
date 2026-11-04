import { evaluate } from "../../logic/interpreter.js";
import type { Answers } from "../../logic/interpreter.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeQuestion, questionSubject } from "../describe.js";
import { citation, provenAnalysis } from "./common.js";

export const CHECK = "deadInputs";

/**
 * Dead inputs, by sensitivity over the exact grid: for a question that is asked somewhere, take every
 * combination where it is asked, change only its answer to each other value it can take, and see whether
 * the result ever changes. Other answers stay fixed; if the change makes another question asked or not
 * asked, that follows the normal rules (a hidden answer is dropped, a newly asked one is unanswered),
 * so a question that only decides whether another is asked still counts as live.
 * A question that never changes the result anywhere is reported as DEAD_INPUT (warning).
 */
export function deadInputs(ctx: CheckContext): Finding[] {
  const a = provenAnalysis(ctx);
  if (a === undefined) return [];
  const model = ctx.model;
  const outcomeAt = (p: Answers): string => evaluate(model, p, { allowMissing: true }).outcome;
  const base = a.points.map((p) => outcomeAt(p));
  const out: Finding[] = [];
  for (const q of model.questions) {
    if ((a.shown.get(q.id) ?? 0) === 0) continue;
    const values = new Set<number | boolean>();
    for (const p of a.points) {
      const v = p[q.id];
      if (v !== undefined) values.add(v);
    }
    let live = false;
    for (let i = 0; i < a.points.length && !live; i++) {
      const p = a.points[i] as Answers;
      const own = p[q.id];
      if (own === undefined) continue;
      for (const v of values) {
        if (v === own) continue;
        if (outcomeAt({ ...p, [q.id]: v }) !== base[i]) {
          live = true;
          break;
        }
      }
    }
    if (live) continue;
    const c = citation(q);
    out.push(
      makeFinding({
        check: CHECK,
        code: "DEAD_INPUT",
        severity: "warning",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [questionSubject(q)],
        params: { item: q.label, described: describeQuestion(q), ...c.params },
        source: c.source,
      }),
    );
  }
  return out;
}
