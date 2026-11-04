import { normalizeForQuote } from "./text.js";

/**
 * Number and unit grounding helpers. Extracts numbers from booklet text (digits, decimals, fractions,
 * the words one..twelve, and once/twice where a frequency is meant) and checks a model number against them,
 * including the unit written next to it. Pure.
 */

export type Tok = { k: "n"; v: number } | { k: "w"; w: string } | { k: "brk" };

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
    for (const m of text.matchAll(/(\d+)\s*\/\s*(\d+)|\d+(?:\.\d+)?|\p{L}+/gu)) {
      const t = m[0];
      if (m[1] !== undefined && m[2] !== undefined) {
        const d = Number(m[2]);
        if (d !== 0) toks.push({ k: "n", v: Number(m[1]) / d });
      } else if (/^\d/.test(t)) {
        toks.push({ k: "n", v: Number(t) });
      } else if (t in WORDS) {
        toks.push({ k: "n", v: WORDS[t] as number });
      } else if (freq && t === "once") {
        toks.push({ k: "n", v: 1 });
      } else if (freq && t === "twice") {
        toks.push({ k: "n", v: 2 });
      } else {
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

function lookup(toks: readonly Tok[], value: number, units: Set<string>): Direct {
  let found = false;
  const seenUnits = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k !== "n" || !same(t.v, value)) continue;
    found = true;
    if (units.size === 0) return { status: "grounded" };
    const near = (dir: 1 | -1): string[] => {
      const got: string[] = [];
      for (let j = i + dir, n = 0; n < 3 && j >= 0 && j < toks.length; j += dir, n++) {
        const u = toks[j] as Tok;
        if (u.k !== "w") break;
        const c = UNIT_WORDS[u.w];
        if (c !== undefined) got.push(c);
      }
      return got;
    };
    let got = near(1);
    if (got.length === 0) got = near(-1);
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
