import type { Condition, Model } from "../../logic/schema.js";

/** An age band in whole months: from `lo` (included) up to `hi` (not included). */
export type Band = { lo: number; hi: number };

/** The question that holds the child's age: the first whole-number question measured in months. */
export function monthsQuestionId(model: Model): string | undefined {
  return model.questions.find((q) => q.answer_type === "integer" && q.unit === "months")?.id;
}

/**
 * The age bands a calculated value uses. Each "all" whose direct children test the age question gives one
 * band (its "at least" tests set the start, its "less than" tests set the end); a test on the age question
 * that is not inside such an "all" is a band of its own. Fractions are rounded up: at least 2.5 months
 * means 3 months and over, since ages are whole months.
 */
export function bandsOf(c: Condition, months: string): Band[] {
  const out: Band[] = [];
  const own = (atoms: Condition[]): Band[] => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const a of atoms) {
      if (!("field" in a) || a.field !== months || a.op === "is_yes") continue;
      if (a.op === "at_least") lo = Math.max(lo, Math.ceil(a.value));
      else hi = Math.min(hi, Math.ceil(a.value));
    }
    return [{ lo, hi }];
  };
  const isAge = (x: Condition): boolean => "field" in x && x.field === months && x.op !== "is_yes";
  const visit = (x: Condition): void => {
    if ("field" in x) {
      if (isAge(x)) out.push(...own([x]));
      return;
    }
    if ("all" in x) {
      const direct = x.all.filter(isAge);
      if (direct.length > 0) out.push(...own(direct));
      for (const k of x.all) if (!isAge(k)) visit(k);
      return;
    }
    for (const k of x.any) visit(k);
  };
  visit(c);
  return out;
}

export type Problem = { kind: "gap" | "overlap"; from: number; to: number };

/** Does the list of bands split [min, below) exactly: no gap, no overlap? Bands outside the range are ignored. */
export function partitionProblems(bands: readonly Band[], min: number, below: number): Problem[] {
  const clipped = bands
    .map((b) => ({ lo: Math.max(b.lo, min), hi: Math.min(b.hi, below) }))
    .filter((b) => b.lo < b.hi)
    .sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  const out: Problem[] = [];
  let cursor = min;
  for (const b of clipped) {
    if (b.lo > cursor) out.push({ kind: "gap", from: cursor, to: b.lo });
    else if (b.lo < cursor) out.push({ kind: "overlap", from: b.lo, to: Math.min(cursor, b.hi) });
    cursor = Math.max(cursor, b.hi);
  }
  if (cursor < below) out.push({ kind: "gap", from: cursor, to: below });
  return out;
}

export const bandText = (bands: readonly Band[]): string =>
  [...bands].sort((a, b) => a.lo - b.lo).map((b) => `${b.lo} up to ${b.hi === Infinity ? "any age" : b.hi} months`).join(", ");

export function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  const key = (x: readonly Band[]): string => [...x].sort((p, q) => p.lo - q.lo || p.hi - q.hi).map((y) => `${y.lo}:${y.hi}`).join("|");
  return key(a) === key(b);
}
