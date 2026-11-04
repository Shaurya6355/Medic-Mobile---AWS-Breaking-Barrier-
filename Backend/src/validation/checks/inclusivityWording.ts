import type { Condition } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import { describeDerived, describeQuestion, describeRule, derivedSubject, questionSubject, ruleSubject } from "../describe.js";
import { normalizeForQuote } from "../text.js";
import { numericComparisons, phrase } from "./numberGrounding.js";

export const CHECK = "inclusivityWording";

/**
 * Which side of a cut-off number N a wording puts N itself on. The draft's two comparisons ("N or more" and
 * "less than N") both put N on the HIGH side. A wording that puts N on the LOW side says the opposite.
 */
type Side = "high" | "low";
type Hit = { side: Side; assumed: boolean; phrase: string; kind: "strictly_more" | "or_less" | "other" };

/** Lookup table: wording just before the number. */
const BEFORE: readonly { re: RegExp; side: Side; assumed?: boolean; kind?: Hit["kind"] }[] = [
  { re: /\b(?:at least|from|a minimum of|minimum of|minimum|no less than|not less than)\s*$/, side: "high" },
  { re: /\b(?:more than|over|above|greater than|older than|exceeding|exceeds|beyond)\s*$/, side: "low", kind: "strictly_more" },
  { re: /\b(?:less than|under|below|fewer than|younger than)\s*$/, side: "high" },
  { re: /\bup to\s*$/, side: "high", assumed: true },
  { re: /\b(?:at most|no more than|not more than|a maximum of|maximum of|maximum)\s*$/, side: "low", kind: "or_less" },
];
/** Lookup table: wording just after the number (and its unit). */
const AFTER: readonly { re: RegExp; side: Side; kind?: Hit["kind"] }[] = [
  { re: /^\s*\+/, side: "high" },
  { re: /^\s*(?:[a-z/]+\s+){0,2}?(?:or|and)\s+(?:more|above|over|older|greater|higher)\b/, side: "high" },
  { re: /^\s*(?:[a-z/]+\s+){0,2}?(?:or|and)\s+(?:less|fewer|under|below|younger|lower)\b/, side: "low", kind: "or_less" },
  { re: /^\s*(?:[a-z/]+\s+){0,2}?up to\s+\d/, side: "high" },
];
const UNIT_AFTER = /^\s*(months?|years?|days?|weeks?|breaths?|tablets?)\b/;

/** Wording found next to the occurrences of `value` (or its value in years, for a question counted in months) in the text. */
function hitsFor(text: string, value: number, months: boolean): Hit[] {
  const t = normalizeForQuote(text);
  const out: Hit[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const idx = m.index ?? 0;
    const n = Number(m[0]);
    const rest = t.slice(idx + m[0].length);
    const unit = rest.match(UNIT_AFTER)?.[1] ?? "";
    const direct = Math.abs(n - value) < 1e-9;
    const years = months && unit.startsWith("year") && Math.abs(n * 12 - value) < 1e-9;
    if (!direct && !years) continue;
    const numText = `${m[0]}${unit !== "" ? " " + unit : ""}`;
    const before = t.slice(Math.max(0, idx - 30), idx);
    for (const b of BEFORE) {
      const hit = before.match(b.re);
      if (hit) out.push({ side: b.side, assumed: b.assumed === true, kind: b.kind ?? "other", phrase: `${hit[0].trim()} ${numText}` });
    }
    const afterWindow = rest.slice(0, 48).split(/[\d,;:.()]/)[0] ?? "";
    for (const a of AFTER) {
      const upTo = a.re.source.includes("up to");
      const hit = (upTo ? rest : afterWindow).match(a.re);
      if (!hit) continue;
      const words = upTo ? `${numText} up to` : `${m[0]} ${hit[0].trim()}`;
      out.push({ side: a.side, assumed: false, kind: a.kind ?? "other", phrase: words.replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

type Item = {
  subjects: Subject[];
  item: string;
  when: Condition;
  sources: readonly { page: number; quote: string }[];
};

/**
 * "More than N" against "N or more" (and the same at the upper end) decides which child falls on which side. For each
 * comparison with a number, the item's own quote is read near that number: a wording that puts the number on the other
 * side than the draft does is blocking; "up to N" is read by the team as not including N, which is reported as an assumption.
 */
export function inclusivityWording(ctx: CheckContext): Finding[] {
  const { model } = ctx;
  const questions = new Map(model.questions.map((q) => [q.id, q]));
  const items: Item[] = [];
  for (const q of model.questions) if (q.shown_when !== undefined) items.push({ subjects: [questionSubject(q)], item: describeQuestion(q), when: q.shown_when, sources: q.source ?? [] });
  for (const d of model.derived) items.push({ subjects: [derivedSubject(d)], item: describeDerived(d), when: d.definition, sources: d.source ?? [] });
  for (const r of model.rules) if (r.when !== "otherwise") items.push({ subjects: [ruleSubject(r)], item: describeRule(model, r), when: r.when, sources: r.source ?? [] });

  const out: Finding[] = [];
  for (const it of items) {
    if (it.sources.length === 0) continue;
    for (const c of numericComparisons(it.when)) {
      const q = questions.get(c.field);
      const unitWords = (q?.unit ?? "").replace(/_/g, " ");
      const months = unitWords.includes("month");
      const hits: (Hit & { page: number; quote: string })[] = [];
      for (const s of it.sources) for (const h of hitsFor(s.quote, c.value, months)) hits.push({ ...h, page: s.page, quote: s.quote });
      if (hits.length === 0) continue;
      const usage = phrase(c.op, String(c.value));
      const subjects = q !== undefined ? [...it.subjects, questionSubject(q)] : it.subjects;
      const label = q?.label ?? c.field;
      const unit = unitWords === "" ? "" : ` ${unitWords}`;
      const confirmedHigh = hits.some((h) => h.side === "high" && !h.assumed);
      const conflict = hits.find((h) => h.side === "low");
      const assumedHit = hits.find((h) => h.assumed);
      const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const, subjects };
      if (!confirmedHigh && conflict !== undefined) {
        out.push(
          makeFinding({
            ...common,
            code: "INCLUSIVITY_MISMATCH",
            severity: "blocking",
            params: {
              item: it.item,
              question: label,
              number: c.value,
              unit,
              sourcePhrase: conflict.phrase,
              meaning: conflict.kind === "strictly_more" ? `does not include ${c.value} itself` : `includes ${c.value} itself on the lower side`,
              usage,
              page: String(conflict.page),
              quote: conflict.quote,
            },
            source: [{ page: conflict.page, quote: conflict.quote }],
          }),
        );
      } else if (!confirmedHigh && assumedHit !== undefined) {
        const open = model.open_questions.find((o) => new RegExp(`exactly ${c.value}\\b`).test(o.question));
        out.push(
          makeFinding({
            ...common,
            code: "INCLUSIVITY_ASSUMED",
            severity: "info",
            params: {
              item: it.item,
              question: label,
              number: c.value,
              unit,
              sourcePhrase: assumedHit.phrase,
              reading: `${c.value}${unit} itself is not included below it, so a child of exactly ${c.value}${unit} counts with the higher group`,
              openQuestion: open?.id ?? "",
              page: String(assumedHit.page),
              quote: assumedHit.quote,
            },
            source: [{ page: assumedHit.page, quote: assumedHit.quote }],
          }),
        );
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
}
