import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { citedItems } from "../describe.js";
import { normalizeForQuote, quoteMatches } from "../text.js";

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
 * of a question, calculated value, rule or result), or named in the draft's list of left-out items. Nothing is dropped silently.
 * Needs ctx.extraction; reports nothing without it.
 */
export function dangerSignCoverage(ctx: CheckContext): Finding[] {
  const ex = ctx.extraction;
  if (ex === undefined) return [];
  const { model } = ctx;
  // Quotes of items that actually implement something; an open question merely mentioning a sign does not model it.
  const modelQuotes = citedItems(model)
    .filter((c) => c.subject.kind !== "open_question" && c.subject.kind !== "scope")
    .flatMap((c) => c.sources.map((s) => s.quote));
  const excludedWords = new Set(normalizeForQuote(model.scope.excluded.map((e) => `${e.item} ${e.reason}`).join(" ")).split(/[^a-z]+/).filter(Boolean));
  const dangerQuestion = model.open_questions.find((q) => /danger signs?/i.test(q.question));

  const out: Finding[] = [];
  for (const sign of ex.danger_signs) {
    const first = sign.src[0];
    const probes = [first?.quote, sign.text].filter((x): x is string => x !== undefined).map(trimEnd).filter((x) => x !== "");
    const modelled = probes.slice(0, 1).some((p) => modelQuotes.some((q) => quoteMatches(p, q)));
    if (modelled) continue;
    const named = namedAsExcluded(sign.text, excludedWords);
    const params = {
      sign: sign.text,
      coughRelevant: sign.cough_relevant,
      openQuestion: dangerQuestion?.id ?? "",
      ...(first !== undefined ? { page: String(first.pdf_page), quote: first.quote.replace(/\s+/g, " ").trim() } : {}),
    };
    const common = {
      check: CHECK,
      audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[],
      decidedBy: "clinician" as const,
      subjects: [{ kind: "scope" as const, id: `danger_sign:${sign.id}` }],
      params,
      source: first !== undefined ? [{ page: first.pdf_page, quote: first.quote.replace(/\s+/g, " ").trim() }] : [],
    };
    if (named) {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_EXCLUDED_NOT_COUGH", severity: "info" }));
    } else {
      out.push(makeFinding({ ...common, code: "DANGER_SIGN_NOT_MODELLED", severity: "blocking" }));
    }
  }
  return out;
}
