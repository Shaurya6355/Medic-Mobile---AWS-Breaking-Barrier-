import { OFFICER, makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { citedItems } from "../describe.js";
import { clip, looksLikeInstruction, normalizeForQuote, quoteMatches } from "../text.js";

export const CHECK = "sourceCoverage";
const MAX_EXAMPLES = 3;
const MAX_PAGES = 10;
const DECISION = /\b(refer|give|follow\s?up|danger|if|days?|months?|tablets?)\b/i;

/**
 * Passages of the booklet that carry numbers or decision words (refer, give, follow up, danger, if, days, months, tablet)
 * and that no item of the draft quotes (neither contains the other). Grouped per page, one short warning each,
 * with the count and a few examples. Needs ctx.extraction; reports nothing without it.
 */
export function sourceCoverage(ctx: CheckContext): Finding[] {
  const ex = ctx.extraction;
  if (ex === undefined) return [];
  const modelQuotes = citedItems(ctx.model).flatMap((c) => c.sources.map((s) => s.quote));

  type Passage = { page: number; quote: string };
  const passages: Passage[] = [];
  for (const n of ex.nodes) {
    if (n.out_of_scope === true || n.kind === "goto") continue;
    for (const s of n.src) passages.push({ page: s.pdf_page, quote: s.quote });
  }
  for (const a of ex.actions) for (const s of a.src) passages.push({ page: s.pdf_page, quote: s.quote });
  for (const f of ex.followups) for (const s of f.src) passages.push({ page: s.pdf_page, quote: s.quote });

  const seen = new Set<string>();
  const uncited = new Map<number, string[]>();
  for (const p of passages) {
    const one = p.quote.replace(/\s+/g, " ").trim();
    if (one === "" || !(/\d/.test(one) || DECISION.test(one))) continue;
    const key = `${p.page}|${normalizeForQuote(one)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const covered = modelQuotes.some((q) => quoteMatches(one, q) || (normalizeForQuote(q).length >= 8 && quoteMatches(q, one)));
    if (covered) continue;
    uncited.set(p.page, [...(uncited.get(p.page) ?? []), one]);
  }

  const out: Finding[] = [...plantedInstructions(ex)];
  for (const page of [...uncited.keys()].sort((a, b) => a - b).slice(0, MAX_PAGES)) {
    const list = uncited.get(page) as string[];
    const examples = list.slice(0, MAX_EXAMPLES).map((q) => `"${clip(q, 80)}"`).join("; ");
    out.push(
      makeFinding({
        check: CHECK,
        code: "UNCITED_PASSAGE",
        severity: "warning",
        audience: OFFICER,
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: `page:${page}` }],
        params: { page: String(page), count: list.length, examples },
        source: [{ page, quote: list[0] as string }],
      }),
    );
  }
  return out;
}

/**
 * Extraction text and quotes are data, never instructions. A string that looks like an instruction to a computer
 * ("ignore previous instructions", "system:") is reported once, blocking, so a person looks at the guideline reading.
 */
function plantedInstructions(ex: NonNullable<CheckContext["extraction"]>): Finding[] {
  const hits: { id: string; text: string }[] = [];
  const walk = (id: string, x: unknown): void => {
    if (typeof x === "string") {
      if (looksLikeInstruction(x)) hits.push({ id, text: x });
    } else if (Array.isArray(x)) x.forEach((y) => walk(id, y));
    else if (x !== null && typeof x === "object") for (const v of Object.values(x)) walk(id, v);
  };
  for (const [key, list] of Object.entries(ex as Record<string, unknown>)) {
    if (key === "_run" || !Array.isArray(list)) continue;
    list.forEach((it, i) => walk(typeof (it as { id?: unknown })?.id === "string" ? String((it as { id: string }).id) : `${key} ${i}`, it));
  }
  if (hits.length === 0) return [];
  const ids = [...new Set(hits.map((h) => h.id))];
  return [
    makeFinding({
      check: CHECK,
      code: "EXTRACTION_TEXT_LOOKS_LIKE_INSTRUCTION",
      severity: "blocking",
      audience: OFFICER,
      decidedBy: "program_officer",
      subjects: [{ kind: "document", id: "extraction" }],
      params: { ids: ids.slice(0, 10).join(", "), example: clip((hits[0] as { text: string }).text, 160), count: hits.length },
      source: [],
    }),
  ];
}
