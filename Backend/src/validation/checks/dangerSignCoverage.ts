import { evaluate } from "../../logic/interpreter.js";
import type { Answers } from "../../logic/interpreter.js";
import { collectFieldRefs } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, FindingInput } from "../finding.js";
import { describeChild, describeCondition, exampleOf } from "../child.js";
import { citedItems, questionSubject } from "../describe.js";
import { normalizeForQuote, quoteMatches } from "../text.js";
import { monthsQuestionId } from "./ageBands.js";
import { outcomeTitle, provenAnalysis, simplestPoint } from "./common.js";
import { containsPassage, instructsReferral, signQuestion } from "./dangerSigns.js";
import type { DangerSign } from "./dangerSigns.js";

export const CHECK = "dangerSignCoverage";

const STOP = new Set(["and", "any", "has", "for", "the", "other", "both", "days", "day", "more", "last", "child", "strap", "from", "with", "red", "yellow", "than", "not", "all"]);

/** The telling words of a danger sign's wording (no filler words, no colours). */
function keywords(text: string): string[] {
  const words = normalizeForQuote(text).split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)];
}

/** Is the sign named in the draft's list of left-out items? At least half of its telling words must appear. */
function namedAsExcluded(signText: string, excludedWords: ReadonlySet<string>): boolean {
  const kws = keywords(signText);
  if (kws.length === 0) return false;
  const found = kws.filter((w) => excludedWords.has(w)).length;
  return found >= Math.max(1, Math.ceil(kws.length / 2));
}

const trimEnd = (q: string): string => q.replace(/[\s,.;:?!]+$/u, "");

/**
 * Every danger sign the guideline reader found in the booklet is either in the draft (its quote is inside a quote
 * of a question, calculated value, rule or result), or named in the draft's list of left-out items. Nothing is dropped
 * silently. Only a sign the extraction marked as not related to cough may be left out; a cough-related one named as
 * left out blocks (DANGER_SIGN_EXCLUDED_COUGH_RELEVANT).
 *
 * For every sign the draft models (red team 1), the logic is then checked one sign at a time:
 *  - the question that asks about it is found (see dangerSigns.ts), else DANGER_SIGN_QUESTION_UNKNOWN;
 *  - it is asked of every child (no condition for asking it), except a condition on a question the sign itself names
 *    ("cough days" asked only when there is cough), else DANGER_SIGN_ASKED_ONLY_SOMETIMES;
 *  - every child within the covered ages who has the sign, whatever the other answers, gets a result of the most urgent
 *    rank used in the draft, else DANGER_SIGN_NOT_URGENT with the simplest such child. This is what catches a sign
 *    dropped from the danger-sign value, routed to a mild rule, or counted only for children with cough. A sign with a
 *    number ("14 days or more") is tested at the booklet's number, not at the draft's cut-off;
 *  - when every combination was gone through and no child in the covered ages can be recorded with the sign,
 *    DANGER_SIGN_CANNOT_BE_RECORDED;
 *  - every result such a child gets tells the health worker to refer, else DANGER_SIGN_OUTCOME_NO_REFERRAL.
 * Needs ctx.extraction; reports nothing without it.
 */
export function dangerSignCoverage(ctx: CheckContext): Finding[] {
  const ex = ctx.extraction;
  if (ex === undefined) return [];
  const { model } = ctx;
  // Quotes of items that actually implement something; an open question merely mentioning a sign does not model it.
  const implementing = citedItems(model).filter((c) => c.subject.kind !== "open_question" && c.subject.kind !== "scope");
  const modelQuotes = implementing.flatMap((c) => c.sources.map((s) => s.quote));
  // Quotes of the items that decide (questions, calculated values, rules), as opposed to the wording of a result.
  const logicQuotes = implementing.filter((c) => c.subject.kind === "question" || c.subject.kind === "derived" || c.subject.kind === "rule").flatMap((c) => c.sources.map((s) => s.quote));
  const excludedWords = new Set(normalizeForQuote(model.scope.excluded.map((e) => `${e.item} ${e.reason}`).join(" ")).split(/[^a-z]+/).filter(Boolean));
  const dangerQuestion = model.open_questions.find((q) => /danger signs?/i.test(q.question));
  const logic = signLogic(ctx);

  const out: Finding[] = [];
  const noReferral = new Set<string>();
  for (const sign of ex.danger_signs) {
    const first = sign.src[0];
    const probes = [first?.quote, sign.text].filter((x): x is string => x !== undefined).map(trimEnd).filter((x) => x !== "");
    const modelled = probes.slice(0, 1).some((p) => modelQuotes.some((q) => quoteMatches(p, q) || containsPassage(q, p)));
    const params = {
      sign: sign.text,
      coughRelevant: sign.cough_relevant,
      openQuestion: dangerQuestion?.id ?? "",
      ...(first !== undefined ? { page: String(first.pdf_page), quote: first.quote.replace(/\s+/g, " ").trim() } : {}),
    };
    const signSubject = { kind: "scope" as const, id: `danger_sign:${sign.id}` };
    const common = {
      check: CHECK,
      audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[],
      decidedBy: "clinician" as const,
      subjects: [signSubject],
      params,
      source: first !== undefined ? [{ page: first.pdf_page, quote: first.quote.replace(/\s+/g, " ").trim() }] : [],
    };
    if (modelled) {
      // A sign not related to cough that only appears in the wording of a result ("return immediately if ... blood in
      // stool") is advice, not a sign the form asks about; every other modelled sign is checked one at a time.
      const decides = probes.slice(0, 1).some((p) => logicQuotes.some((q) => quoteMatches(p, q) || containsPassage(q, p)));
      if (sign.cough_relevant || decides) out.push(...logic(sign, common, noReferral));
      continue;
    }
    const named = namedAsExcluded(sign.text, excludedWords);
    if (named && sign.cough_relevant) {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_EXCLUDED_COUGH_RELEVANT", severity: "blocking" }));
    } else if (named) {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_EXCLUDED_NOT_COUGH", severity: "info" }));
    } else {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_NOT_MODELLED", severity: "blocking" }));
    }
  }
  return out;
}

type Common = Omit<FindingInput, "code" | "severity">;

/** The per-sign logic checks, sharing one evaluation of every combination of answers. */
function signLogic(ctx: CheckContext): (sign: DangerSign, common: Common, noReferral: Set<string>) => Finding[] {
  const model = ctx.model;
  // Only over the full set of combinations (a partial set is already NOT_PROVEN and would cost too much to go through again).
  const a = provenAnalysis(ctx);
  const ageId = monthsQuestionId(model);
  const { age_months_min: lo, age_months_below: hi } = model.scope;
  const top = Math.min(...model.outcomes.map((o) => o.severity));
  const sev = new Map(model.outcomes.map((o) => [o.id, o.severity]));
  let outcomes: string[] | undefined;
  const outcomeAt = (i: number): string => {
    if (outcomes === undefined) outcomes = (a?.points ?? []).map((p) => evaluate(model, p, { allowMissing: true }).outcome);
    return outcomes[i] as string;
  };
  const inScope = (p: Answers): boolean => {
    if (ageId === undefined) return true;
    const v = p[ageId];
    return typeof v === "number" && v >= lo && v < hi;
  };
  const urgentTitle = model.outcomes.filter((o) => o.severity === top).map((o) => o.title)[0] ?? "";

  return (sign, common, noReferral) => {
    const out: Finding[] = [];
    const sq = signQuestion(model, sign);
    const q = sq.question;
    if (q === undefined) {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_QUESTION_UNKNOWN", severity: "blocking", decidedBy: "program_officer" }));
      return out;
    }
    const withQ = { ...common, subjects: [...common.subjects, questionSubject(q)], params: { ...common.params, question: q.label } };
    if (q.shown_when !== undefined) {
      const signWords = new Set(normalizeForQuote(sign.text).split(/[^a-z0-9]+/).filter(Boolean));
      const allowed = collectFieldRefs(q.shown_when).every((f) => {
        const g = model.questions.find((x) => x.id === f);
        return g !== undefined && g.answer_type === "yes_no" && f.split("_").every((w) => signWords.has(w));
      });
      if (!allowed) {
        out.push(makeFinding({ ...withQ, code: "DANGER_SIGN_ASKED_ONLY_SOMETIMES", severity: "blocking", params: { ...withQ.params, guard: describeCondition(model, q.shown_when) } }));
      }
    }
    if (a === undefined || sq.present === undefined || a.rules === undefined) return out;
    const present = sq.present;
    const hits: number[] = [];
    a.points.forEach((p, i) => {
      const v = p[q.id];
      if (v !== undefined && present(v) && inScope(p)) hits.push(i);
    });
    if (hits.length === 0) {
      out.push(makeFinding({ ...withQ, code: "DANGER_SIGN_CANNOT_BE_RECORDED", severity: "blocking" }));
      return out;
    }
    const bad = hits.filter((i) => (sev.get(outcomeAt(i)) ?? Infinity) > top);
    if (bad.length > 0) {
      const badSet = new Set(bad.map((i) => a.points[i] as Answers));
      const child = simplestPoint(a.points, (p) => badSet.has(p)) as Answers;
      const got = outcomeAt(a.points.indexOf(child));
      out.push(
        makeFinding({
          ...withQ,
          code: "DANGER_SIGN_NOT_URGENT",
          severity: "blocking",
          subjects: [...withQ.subjects, { kind: "outcome", id: got }],
          params: { ...withQ.params, child: describeChild(model, child), outcome: outcomeTitle(model, got), urgent: urgentTitle },
          example: exampleOf(child),
        }),
      );
    }
    for (const id of new Set(hits.map(outcomeAt))) {
      if (noReferral.has(id)) continue;
      const o = model.outcomes.find((x) => x.id === id);
      if (o === undefined || instructsReferral(o, ctx.extraction)) continue;
      noReferral.add(id);
      out.push(
        makeFinding({
          ...withQ,
          code: "DANGER_SIGN_OUTCOME_NO_REFERRAL",
          severity: "blocking",
          subjects: [{ kind: "outcome", id }],
          params: { ...withQ.params, outcome: o.title },
        }),
      );
    }
    return out;
  };
}
