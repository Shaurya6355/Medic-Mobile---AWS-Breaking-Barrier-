import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { openQuestionSubject } from "../describe.js";
import { citation } from "./common.js";
import { clip } from "../text.js";
import { isMeaningfulText, type HistoryContext, type VersionHistoryEntry } from "../context.js";
import type { OpenQuestion } from "../../logic/schema.js";

export const CHECK = "openQuestions";

type Route = OpenQuestion["route_to"];

/**
 * Every open question stays a blocking finding for the person it is routed to until it is answered
 * (BR-04, GR-07: unclear passages are never settled silently). Blocking for that person as well (DEC-020):
 * - a question marked answered with no answer written down, or with an answer that says nothing
 *   ("x", "ok", one word; see isMeaningfulText);
 * With the version chain (ctx.history, passed by the sign-off service):
 * - a question that an earlier version had and this one no longer has (removing it is not answering it);
 * - a question routed to someone else than when it was first raised;
 * - an answer first written in a version saved by another role than the one the question is routed to,
 *   or with no role recorded; a later version cannot launder it, only rewriting the answer in the right role;
 * - a clinician's answer whose version does not record the clinician's name and a change note.
 * The first version has no earlier one to compare with: fill_logic writes every question open there.
 */
export function openQuestions(ctx: CheckContext): Finding[] {
  const history = (ctx as CheckContext & HistoryContext).history;
  const out: Finding[] = [];
  const first = firstAppearance(history);

  const push = (q: Pick<OpenQuestion, "id" | "question" | "affects" | "source">, route: Route, code: string, extra: Record<string, string> = {}) => {
    const cite = citation(q as OpenQuestion);
    out.push(
      makeFinding({
        check: CHECK,
        code,
        severity: "blocking",
        audience: [route],
        decidedBy: route,
        subjects: [openQuestionSubject(q as OpenQuestion)],
        source: cite.source,
        params: { id: q.id, question: clip(q.question, 400), route, affects: q.affects.join(", "), ...cite.params, ...extra },
      }),
    );
  };

  for (const q of ctx.model.open_questions) {
    // The person who decides is the one the question was first routed to.
    const route = first.get(q.id)?.question.route_to ?? q.route_to;
    if (q.route_to !== route) push(q, route, "OPEN_QUESTION_REROUTED", { now: q.route_to });
    if (q.status === "open") {
      push(q, route, "OPEN_QUESTION");
      continue;
    }
    if (q.resolution === undefined || q.resolution.trim() === "") {
      push(q, route, "OPEN_QUESTION_NO_RESOLUTION");
      continue;
    }
    if (!isMeaningfulText(q.resolution)) {
      push(q, route, "OPEN_QUESTION_TRIVIAL_RESOLUTION", { resolution: clip(q.resolution, 80) });
      continue;
    }
    const by = answeredIn(history, q);
    if (by === undefined) continue;
    if (by.authorRole !== route) {
      push(q, route, "OPEN_QUESTION_WRONG_RESOLVER", { version: String(by.n), savedAs: by.authorRole ?? "" });
    } else if (route === "clinician" && (by.author.trim() === "" || !isMeaningfulText(by.model.meta.change_note))) {
      push(q, route, "OPEN_QUESTION_CLINICIAN_NOT_RECORDED", { version: String(by.n) });
    }
  }

  const now = new Set(ctx.model.open_questions.map((q) => q.id));
  for (const [id, { question }] of first) {
    if (!now.has(id)) push(question, question.route_to, "OPEN_QUESTION_REMOVED");
  }
  return out;
}

/** Each question id with the first version (oldest first) in which it appears. */
function firstAppearance(history: readonly VersionHistoryEntry[] | undefined): Map<string, { n: number; question: OpenQuestion }> {
  const out = new Map<string, { n: number; question: OpenQuestion }>();
  for (const e of history ?? []) {
    for (const q of e.model.open_questions) if (!out.has(q.id)) out.set(q.id, { n: e.n, question: q });
  }
  return out;
}

/**
 * The version in which the current answer to q was written: the oldest version of the unbroken run, ending
 * at the checked version, in which q is resolved with exactly this answer. Undefined without history or when
 * that run starts at the first version (nothing earlier to compare with).
 */
function answeredIn(history: readonly VersionHistoryEntry[] | undefined, q: OpenQuestion): VersionHistoryEntry | undefined {
  if (history === undefined || history.length === 0) return undefined;
  let i = history.length - 1;
  const same = (e: VersionHistoryEntry): boolean =>
    e.model.open_questions.some((x) => x.id === q.id && x.status === "resolved" && x.resolution === q.resolution);
  while (i > 0 && same(history[i - 1]!)) i--;
  return i === 0 ? undefined : history[i];
}
