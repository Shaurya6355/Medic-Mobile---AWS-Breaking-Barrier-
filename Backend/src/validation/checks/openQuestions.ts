import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { openQuestionSubject } from "../describe.js";
import { citation } from "./common.js";
import { clip } from "../text.js";

export const CHECK = "openQuestions";

/**
 * Every open question stays a blocking finding for the person it is routed to until it is answered
 * (BR-04, GR-07: unclear passages are never settled silently). An answered question needs its answer written down.
 */
export function openQuestions(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  for (const q of ctx.model.open_questions) {
    const cite = citation(q);
    const base = {
      check: CHECK,
      audience: [q.route_to],
      decidedBy: q.route_to,
      subjects: [openQuestionSubject(q)],
      source: cite.source,
    };
    const params = { id: q.id, question: clip(q.question, 400), route: q.route_to, affects: q.affects.join(", "), ...cite.params };
    if (q.status === "open") {
      out.push(makeFinding({ ...base, code: "OPEN_QUESTION", severity: "blocking", params }));
    } else if (q.resolution === undefined || q.resolution.trim() === "") {
      out.push(makeFinding({ ...base, code: "OPEN_QUESTION_NO_RESOLUTION", severity: "warning", params }));
    }
  }
  return out;
}
