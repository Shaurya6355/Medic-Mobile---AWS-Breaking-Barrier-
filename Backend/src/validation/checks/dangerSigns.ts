import type { Condition, Model } from "../../logic/schema.js";
import type { Extraction } from "../context.js";
import { normalizeForQuote } from "../text.js";
import { ageOnlyRules, monthsQuestionId } from "./ageBands.js";

/**
 * Which parts of a draft deal with danger signs. Shared by dangerSignCoverage, severityOrder and
 * followUpConsistency, so that "a referral" is decided by the logic (what a child with a danger sign gets),
 * never by the word "refer" in a title.
 */

type Question = Model["questions"][number];
export type DangerSign = Extraction["danger_signs"][number];

export type SignQuestion = {
  sign: DangerSign;
  /** The question that asks about the sign, when one is found. */
  question?: Question;
  /** For a whole-number question: when its answer means the sign is there ("14 days or more"). */
  present?: (v: number | boolean) => boolean;
  /** The words that say when the sign is there, for messages ("14 days or more"). */
  presentText?: string;
};

const squash = (s: string): string => normalizeForQuote(s).replace(/[\s\-.,;:?!()"']/g, "");
const wordsOf = (s: string): string[] => normalizeForQuote(s.replace(/_/g, " ")).split(/[^a-z0-9]+/).filter(Boolean);
const singular = (w: string): string => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

/** Does the text contain the passage (spacing, hyphenation, punctuation and case ignored)? */
export function containsPassage(text: string, passage: string): boolean {
  const p = squash(passage);
  return p.length >= 3 && squash(text).includes(p);
}

/** "Cough for 14 days or more" -> at least 14; "more than 14 days" -> at least 15; "less than 2 months" -> below 2. */
function presence(text: string): { present: (v: number | boolean) => boolean; presentText: string } | undefined {
  const t = normalizeForQuote(text);
  let m = /(\d+)\s*([a-z]+)?\s*(?:or more|or longer|or above|and more|and over|or over)/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return { present: (v) => typeof v === "number" && v >= n, presentText: `${n}${m[2] ? ` ${m[2]}` : ""} or more` };
  }
  m = /(?:more than|over|longer than|above)\s*(\d+)\s*([a-z]+)?/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return { present: (v) => typeof v === "number" && v > n, presentText: `more than ${n}${m[2] ? ` ${m[2]}` : ""}` };
  }
  m = /(?:less than|under|below|fewer than)\s*(\d+)\s*([a-z]+)?/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return { present: (v) => typeof v === "number" && v < n, presentText: `less than ${n}${m[2] ? ` ${m[2]}` : ""}` };
  }
  return undefined;
}

/**
 * The question that asks about a danger sign:
 *  1. a question that cites the sign's booklet words (or whose own wording contains them);
 *  2. otherwise a whole-number question whose unit is named in the sign ("days") and whose name shares another
 *     word with it ("cough_days" for "Cough for 14 days or more");
 *  3. otherwise a yes-or-no question whose name is made only of words of the sign ("convulsions").
 * A whole-number question gets the presence test the sign's words give ("14 days or more").
 */
export function signQuestion(model: Model, sign: DangerSign): SignQuestion {
  const probes = [sign.src[0]?.quote, sign.text].filter((x): x is string => x !== undefined && x.trim() !== "");
  const signWords = new Set(wordsOf(sign.text).map(singular));
  const pres = presence(sign.text);
  const byQuote = model.questions.filter((q) =>
    probes.some((p) => (q.source ?? []).some((s) => containsPassage(s.quote, p)) || containsPassage(q.label, p)),
  );
  let q: Question | undefined =
    byQuote.find((x) => (pres !== undefined) === (x.answer_type === "integer")) ?? byQuote[0];
  if (q === undefined && pres !== undefined) {
    q = model.questions.find((x) => {
      if (x.answer_type !== "integer" || x.unit === undefined) return false;
      const unit = wordsOf(x.unit).map(singular);
      if (!unit.every((u) => signWords.has(u))) return false;
      return wordsOf(x.id).map(singular).some((w) => !unit.includes(w) && signWords.has(w));
    });
  }
  if (q === undefined) {
    q = model.questions.find((x) => x.answer_type === "yes_no" && wordsOf(x.id).map(singular).every((w) => signWords.has(w)));
  }
  if (q === undefined) return { sign };
  if (q.answer_type === "yes_no") return { sign, question: q, present: (v) => v === true, presentText: "yes" };
  return pres === undefined ? { sign, question: q } : { sign, question: q, ...pres };
}

/** The cough-related danger signs the extraction found, each with its question when found. */
export function coughSignQuestions(model: Model, extraction: Extraction | undefined): SignQuestion[] {
  if (extraction === undefined) return [];
  return extraction.danger_signs.filter((s) => s.cough_relevant).map((s) => signQuestion(model, s));
}

function refsOf(c: Condition): string[] {
  const out = new Set<string>();
  const stack: Condition[] = [c];
  while (stack.length > 0) {
    const x = stack.pop() as Condition;
    if ("field" in x) out.add(x.field);
    else stack.push(...("all" in x ? x.all : x.any));
  }
  return [...out];
}

/**
 * Fields that carry a danger sign: the questions of the cough-related danger signs (from the extraction), every
 * calculated value named or labelled as a danger sign, and every calculated value that reads one of these.
 */
export function dangerFieldIds(model: Model, extraction: Extraction | undefined): Set<string> {
  const fields = new Set<string>();
  for (const s of coughSignQuestions(model, extraction)) if (s.question !== undefined) fields.add(s.question.id);
  for (const d of model.derived) if (/danger/i.test(d.id) || /danger/i.test(d.label)) fields.add(d.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of model.derived) {
      if (fields.has(d.id)) continue;
      if (refsOf(d.definition).some((r) => fields.has(r))) {
        fields.add(d.id);
        grew = true;
      }
    }
  }
  return fields;
}

/** The rules for children outside the covered ages (they decide on the age alone). */
export function scopeRuleIds(model: Model): Set<string> {
  const ageId = monthsQuestionId(model);
  return new Set(ageId === undefined ? [] : ageOnlyRules(model, ageId).map((r) => r.id));
}

/**
 * Results a danger sign leads to: the results of every rule (other than the catch-all and the rules for children
 * outside the covered ages) whose condition reads a danger-sign field. These are the referrals, whatever their wording.
 */
export function dangerOutcomeIds(model: Model, extraction: Extraction | undefined): Set<string> {
  const fields = dangerFieldIds(model, extraction);
  const scope = scopeRuleIds(model);
  const out = new Set<string>();
  for (const r of model.rules) {
    if (r.when === "otherwise" || scope.has(r.id)) continue;
    if (refsOf(r.when).some((f) => fields.has(f))) out.add(r.outcome);
  }
  return out;
}

/** True when the result tells the health worker to refer the child (its title or an action says so, or an action cites a referral passage). */
export function instructsReferral(o: Model["outcomes"][number], extraction: Extraction | undefined): boolean {
  if (/\brefer/i.test(o.title) || o.actions.some((a) => /\brefer/i.test(a.text))) return true;
  const referQuotes = (extraction?.actions ?? [])
    .filter((a) => typeof a["type"] === "string" && /refer/i.test(a["type"] as string))
    .flatMap((a) => a.src.map((x) => x.quote));
  return o.actions.some((a) => (a.source ?? []).some((s) => referQuotes.some((q) => containsPassage(s.quote, q))));
}
