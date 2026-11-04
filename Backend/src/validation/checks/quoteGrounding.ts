import { BOTH, makeFinding } from "../finding.js";
import type { CheckContext, Finding, SourceDocument } from "../finding.js";
import { citedItems } from "../describe.js";
import { clip, normalizeForQuote, quoteMatches } from "../text.js";

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

/** Every quote, after normalisation, is a substring of the text of the page it cites (all blocks of that page). */
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
      const text = doc.pageText(s.page);
      if (text === undefined) {
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
      if (!quoteMatches(s.quote, text)) {
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
