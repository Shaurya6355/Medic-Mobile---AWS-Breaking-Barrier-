import { BOTH, makeFinding } from "../finding.js";
import type { CheckContext, Finding, SourceDocument } from "../finding.js";
import { citedItems } from "../describe.js";
import { clip, matchOnPage, normalizeForQuote } from "../text.js";

export const CHECK = "quoteGrounding";

/** The block of the page that shares the most words with the quote, to show what the booklet says there. */
function closestBlock(doc: SourceDocument, page: number, quote: string): string {
  const words = new Set(normalizeForQuote(quote).split(" ").filter((w) => w.length > 2));
  let best = "";
  let bestScore = -1;
  for (const b of doc.pages.get(page) ?? []) {
    const score = normalizeForQuote(b.text).split(" ").filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = b.text;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Every quote, after normalisation, is found inside ONE block of the page it cites (never stitched across blocks),
 * starting and ending on a word boundary. A quote of fewer than 2 words and 8 characters, or one that leaves out a
 * "not" (or "no", "without", ...) standing just before it in the booklet, is blocking.
 */
export function quoteGrounding(ctx: CheckContext): Finding[] {
  const doc = ctx.document;
  if (doc === undefined) {
    return [
      makeFinding({
        check: CHECK,
        code: "SOURCE_DOCUMENT_MISSING",
        severity: "blocking",
        audience: ["program_officer"],
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: "source" }],
        params: { what: "quotes" },
        source: [],
      }),
    ];
  }
  const out: Finding[] = [];
  for (const it of citedItems(ctx.model)) {
    for (const s of it.sources) {
      const common = { check: CHECK, subjects: [it.subject], source: [{ page: s.page, quote: s.quote }] };
      if (s.quote.trim() === "") {
        out.push(
          makeFinding({
            ...common,
            code: "EMPTY_QUOTE",
            severity: "blocking",
            audience: BOTH,
            decidedBy: "program_officer",
            params: { item: it.item, page: String(s.page) },
          }),
        );
        continue;
      }
      const blocks = doc.pages.get(s.page);
      if (blocks === undefined) {
        out.push(
          makeFinding({
            ...common,
            code: "SOURCE_PAGE_MISSING",
            severity: "blocking",
            audience: ["program_officer"],
            decidedBy: "program_officer",
            params: { item: it.item, page: String(s.page) },
          }),
        );
        continue;
      }
      const m = matchOnPage(s.quote, blocks);
      if (m === "too_short") {
        out.push(
          makeFinding({
            ...common,
            code: "QUOTE_TOO_SHORT",
            severity: "blocking",
            audience: BOTH,
            decidedBy: "program_officer",
            params: { item: it.item, page: String(s.page), quote: clip(s.quote, 240) },
          }),
        );
      } else if (m === "negated") {
        out.push(
          makeFinding({
            ...common,
            code: "QUOTE_DROPS_NEGATION",
            severity: "blocking",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            params: { item: it.item, page: String(s.page), quote: clip(s.quote, 240), blockText: clip(closestBlock(doc, s.page, s.quote), 240) },
          }),
        );
      } else if (m === "absent") {
        out.push(
          makeFinding({
            ...common,
            code: "HALLUCINATED_CITATION",
            severity: "blocking",
            audience: BOTH,
            decidedBy: "program_officer",
            params: { item: it.item, page: String(s.page), quote: clip(s.quote, 240), blockText: clip(closestBlock(doc, s.page, s.quote), 240) },
          }),
        );
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
}
