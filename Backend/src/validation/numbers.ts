import { normalizeForQuote } from "./text.js";

/**
 * Number and unit grounding helpers. Extracts numbers from booklet text (digits, decimals, fractions,
 * the words one..twelve, and once/twice where a frequency is meant) and checks a model number against them,
 * including the unit written right after it. Pure.
 *
 * Hardened (red team 2): the unit must directly follow the number; a number word ("one", "twelve") counts only
 * when a unit (or, for once/twice, "daily", "a day") follows it; a page number ("page 8") never counts.
 */

/** `word`: written as a word ("one", "twice"), which needs a unit (or frequency wording) right after it to count. */
export type Tok = { k: "n"; v: number; word?: boolean } | { k: "w"; w: string } | { k: "brk" };

const PAGE_WORDS = new Set(["page", "pages", "p", "pg"]);

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Tokenise text segments. A break token separates segments so a unit cannot be borrowed across them.
 * `freq` makes "once" = 1 and "twice" = 2 count as numbers (only wanted for times per day).
 */
export function tokenize(segments: readonly string[], freq: boolean): Tok[] {
  const toks: Tok[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) toks.push({ k: "brk" });
    const text = normalizeForQuote(seg).replace(/½/g, " 1/2 ");
    /** After "page", "pages", "p" or "pg": the numbers that follow (joined by "and") name pages. */
    let pageMode = false;
    for (const m of text.matchAll(/(\d+)\s*\/\s*(\d+)|\d+(?:\.\d+)?|\p{L}+/gu)) {
      const t = m[0];
      if (m[1] !== undefined && m[2] !== undefined) {
        const d = Number(m[2]);
        if (d !== 0 && !pageMode) toks.push({ k: "n", v: Number(m[1]) / d });
      } else if (/^\d/.test(t)) {
        // A page number is kept out as a plain word, so it can neither ground a number nor lend a unit.
        if (pageMode) toks.push({ k: "w", w: "#page" });
        else toks.push({ k: "n", v: Number(t) });
      } else if (t in WORDS) {
        toks.push({ k: "n", v: WORDS[t] as number, word: true });
      } else if (freq && t === "once") {
        toks.push({ k: "n", v: 1, word: true });
      } else if (freq && t === "twice") {
        toks.push({ k: "n", v: 2, word: true });
      } else {
        if (PAGE_WORDS.has(t)) pageMode = true;
        else if (t !== "and") pageMode = false;
        toks.push({ k: "w", w: t });
      }
    }
  });
  return toks;
}

const UNIT_WORDS: Record<string, string> = {
  month: "month", months: "month", mo: "month", mos: "month",
  year: "year", years: "year", yr: "year", yrs: "year",
  day: "day", days: "day",
  week: "week", weeks: "week", wk: "week", wks: "week",
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour",
  minute: "minute", minutes: "minute", min: "minute", mins: "minute",
  breath: "breath", breaths: "breath", bpm: "breath",
  tablet: "tablet", tablets: "tablet", tab: "tablet", tabs: "tablet",
  mg: "mg", ml: "ml", dose: "dose", doses: "dose", drop: "drop", drops: "drop", sachet: "sachet", sachets: "sachet",
};

/** The canonical unit a single word names ("tabs" -> tablet), or undefined. */
export function unitWord(w: string): string | undefined {
  return UNIT_WORDS[w.toLowerCase()];
}

/** Units of time: a time unit next to a number says nothing about what the number is about. */
export const TIME_UNITS: ReadonlySet<string> = new Set(["month", "year", "day", "week", "hour", "minute"]);

/** Canonical units named by a unit string such as "breaths/min" (-> breath, minute). Empty when unknown. */
export function canonUnits(unit: string | undefined): Set<string> {
  const out = new Set<string>();
  if (unit === undefined) return out;
  for (const w of unit.toLowerCase().split(/[^a-z]+/)) {
    const c = UNIT_WORDS[w];
    if (c !== undefined) out.add(c);
  }
  return out;
}

/** Explicit, small conversion table: [value, unit] is the same amount as [value, unit]. */
export const CONVERSIONS: readonly (readonly [number, string, number, string])[] = [
  [12, "month", 1, "year"],
  [24, "month", 2, "year"],
  [60, "month", 5, "year"],
  [7, "day", 1, "week"],
  [14, "day", 2, "week"],
];

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

type Direct = { status: "grounded" | "absent" | "no_unit" } | { status: "unit_mismatch"; textUnits: string[] };

const FREQ_AFTER = new Set(["daily", "a", "per", "every", "each"]);

function lookup(toks: readonly Tok[], value: number, units: Set<string>): Direct {
  let found = false;
  const seenUnits = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k !== "n" || !same(t.v, value)) continue;
    // The unit is the word right after the number, nothing further on and nothing before it.
    const next = toks[i + 1];
    const unit = next !== undefined && next.k === "w" ? UNIT_WORDS[next.w] : undefined;
    if (t.word === true && unit === undefined && !(next !== undefined && next.k === "w" && FREQ_AFTER.has(next.w))) continue;
    found = true;
    if (units.size === 0) return { status: "grounded" };
    const got = unit !== undefined ? [unit] : [];
    for (const c of got) {
      if (units.has(c)) return { status: "grounded" };
      seenUnits.add(c);
    }
  }
  if (!found) return { status: "absent" };
  return seenUnits.size > 0 ? { status: "unit_mismatch", textUnits: [...seenUnits].sort() } : { status: "no_unit" };
}

export type Grounding =
  | { status: "grounded" | "absent" | "no_unit" }
  | { status: "unit_mismatch"; textUnits: string[] }
  | { status: "converted"; textValue: number; textUnit: string; derivation: string };

/**
 * Is `value` (in `unit`, if the model gives one) supported by the tokens?
 * A direct match wins; otherwise the explicit conversion table is tried; the derivation is returned, never hidden.
 */
export function groundNumber(toks: readonly Tok[], value: number, unit: string | undefined): Grounding {
  const units = canonUnits(unit);
  const direct = lookup(toks, value, units);
  if (direct.status === "grounded") return direct;
  if (units.size > 0) {
    for (const [a, ua, b, ub] of CONVERSIONS) {
      for (const [mv, mu, tv, tu] of [[a, ua, b, ub], [b, ub, a, ua]] as const) {
        if (same(mv, value) && units.has(mu) && lookup(toks, tv, new Set([tu])).status === "grounded") {
          const label = (n: number, u: string): string => `${n} ${n === 1 ? u : u + "s"}`;
          return { status: "converted", textValue: tv, textUnit: tu, derivation: `${label(mv, mu)} is the same as ${label(tv, tu)}` };
        }
      }
    }
  }
  return direct;
}
