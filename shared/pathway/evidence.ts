/* Checks against outside evidence: the guideline text (quote and number checks) and a second, independent
   draft (cross check). Pure and deterministic, shared by the backend pipeline and the review UI. */
import { evaluate } from "./evaluate.ts";
import { literals, patients, sources } from "./compile.ts";
import { item, splitItem, srcList, type Answers, type ItemId, type Source, type Spec } from "./types.ts";

/** One page of extracted guideline text. */
export interface Page { page: number; text: string }

export const normalise = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
const norm = (s: string) => normalise(s).toLowerCase();

/* ---------- 2a. Quote check ---------- */
export interface QuoteResult { item: ItemId; path: string; source: Source; found: boolean; onPage: boolean; foundOn: number[] }
/** Every source quote must appear verbatim (case and whitespace aside), on the page it cites. */
export function quoteResults(spec: Spec, pages: Page[]): QuoteResult[] {
  const byPage = new Map<number, string>();
  pages.forEach(p => byPage.set(p.page, (byPage.get(p.page) ?? "") + " " + norm(p.text)));
  return sources(spec).map(({ item: it, path, source }) => {
    const q = norm(source.quote);
    const foundOn = q ? [...byPage].filter(([, t]) => t.includes(q)).map(([p]) => p) : [];
    return { item: it, path, source, found: foundOn.length > 0, onPage: foundOn.includes(source.page), foundOn };
  });
}

/* ---------- 2b. Number check ---------- */
/** Numbers a passage states. "5 years" also counts as 60 months, "a week" as 7 days. */
export function numbersIn(text: string): Set<number> {
  const s = new Set<number>();
  for (const x of text.matchAll(/(\d+(?:\.\d+)?)\s*(years?|weeks?)?/gi)) {
    const n = Number(x[1]); s.add(n);
    if (/^year/i.test(x[2] || "")) s.add(n * 12);
    if (/^week/i.test(x[2] || "")) s.add(n * 7);
  }
  if (/\ba week\b/i.test(text)) s.add(7);
  return s;
}
export interface NumberResult { item: ItemId; what: string; value: number; quote: string; ok: boolean }
/** Every number taken from the guideline must appear in the passage its own step cites. Team-written steps are skipped. */
export function numberResults(spec: Spec): NumberResult[] {
  const out: NumberResult[] = [];
  const check = (it: ItemId, what: string, value: number | null | undefined, src: Source | Source[] | undefined) => {
    if (typeof value !== "number") return;
    const quote = srcList(src).map(s => s.quote).join(" … ");
    out.push({ item: it, what, value, quote, ok: numbersIn(quote).has(value) });
  };
  if (spec.scope.source) {
    check(item.scope, "lowest age (months)", spec.scope.age_months_min, spec.scope.source);
    check(item.scope, "age limit (months)", spec.scope.age_months_below, spec.scope.source);
  }
  literals(spec).forEach(l => {
    const [k, key] = splitItem(l.item);
    const x = k === "d" ? spec.derived.find(d => d.id === key) : spec.rules.find(r => r.id === key);
    if (x?.origin === "guideline") check(l.item, l.leaf.field + " " + l.leaf.op.replace("_", " "), l.leaf.value, x.source);
  });
  spec.outcomes.forEach(o => { if (o.follow_up?.origin === "guideline") check(item.fu(o.id), "follow-up due day", o.follow_up.due_in_days, o.follow_up.source); });
  return out;
}

/* ---------- 5. Cross check ---------- */
export interface Disagreement { answers: Answers; a: string | null; b: string | null; ruleA: string | null; ruleB: string | null }
export interface ValueDiff { path: string; item: ItemId; field: string; a: number; b: number }
/** Draft A and draft B came from independent runs. Run both on the same patients (boundary values of both) and compare. */
export function crossCheck(a: Spec, b: Spec, given?: [Answers[], Answers[]]): { patients: number; disagree: Disagreement[]; values: ValueDiff[] } {
  const seen = new Set<string>(), ps: Answers[] = [];
  const [pa, pb] = given ?? [patients(a), patients(b)];
  [...pa, ...pb].forEach(p => { const k = JSON.stringify(p); if (!seen.has(k)) { seen.add(k); ps.push(p); } });
  const disagree: Disagreement[] = [];
  ps.forEach(p => {
    const x = evaluate(a, p), y = evaluate(b, p);
    if (x.outcome !== y.outcome) disagree.push({ answers: p, a: x.outcome, b: y.outcome, ruleA: x.rule, ruleB: y.rule });
  });
  const key = (path: (string | number)[]) => path.join(".");
  const bv = new Map(literals(b).map(l => [key(l.path), l.leaf.value!]));
  const values = literals(a).filter(l => bv.has(key(l.path)) && bv.get(key(l.path)) !== l.leaf.value)
    .map(l => ({ path: key(l.path), item: l.item, field: l.leaf.field, a: l.leaf.value!, b: bv.get(key(l.path))! }));
  return { patients: ps.length, disagree, values };
}
