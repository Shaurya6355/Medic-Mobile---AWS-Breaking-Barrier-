/**
 * Pure XPath emission for the CHT compiler (XLSForm `${field}` syntax).
 *
 * Rules (fixed, unit-tested with exact strings):
 *   is_yes          -> ${f} = 'yes'
 *   at_least v      -> (${f} != '' and ${f} >= v)
 *   less_than v     -> (${f} != '' and ${f} < v)
 *   all             -> parenthesised ' and ' join
 *   any             -> parenthesised ' or ' join
 *   derived id      -> ${id} = 'yes'   (derived values are 'yes'/'no' calculates)
 * Flow-only relevance (derived question flow, never in the model):
 *   is_no           -> ${f} = 'no'     (blank is not 'no')
 *   "never"         -> false()
 * Number literals are printed in plain decimal, never exponent notation. not() is never emitted.
 */
import type { Condition, FlowCondition, FlowRelevance } from "../logic/index.js";

export class XpathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XpathError";
  }
}

export interface XpathContext {
  /** Ids of derived values: only is_yes may read them. */
  derived: ReadonlySet<string>;
}

/** Plain-decimal rendering of a finite number (no exponent, no grouping). */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new XpathError(`number literal must be finite, got ${String(n)}`);
  if (n === 0) return "0";
  const s = String(n);
  const e = s.indexOf("e");
  if (e === -1) return s;
  const negative = n < 0;
  const mantissa = s.slice(negative ? 1 : 0, e);
  const exponent = Number(s.slice(e + 1));
  const [intPart = "", fracPart = ""] = mantissa.split(".");
  const digits = intPart + fracPart;
  // position of the decimal point within `digits`
  const point = intPart.length + exponent;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

const ref = (field: string): string => `\${${field}}`;

/** Iterative-safe in practice: parseModel caps condition depth at 32, so recursion is bounded. */
export function conditionToXpath(c: Condition, ctx: XpathContext): string {
  return emit(c, ctx);
}

/** Relevance from the derived flow: undefined for no restriction, false() for "never". */
export function flowRelevanceToXpath(c: FlowRelevance, ctx: XpathContext): string | undefined {
  if (c === null) return undefined;
  if (c === "never") return "false()";
  return emit(c, ctx);
}

function emit(c: FlowCondition, ctx: XpathContext): string {
  if ("field" in c) {
    if (c.op === "is_yes") return `${ref(c.field)} = 'yes'`;
    if (c.op === "is_no") {
      if (ctx.derived.has(c.field)) throw new XpathError(`is_no reads questions only, not the derived value "${c.field}"`);
      return `${ref(c.field)} = 'no'`;
    }
    if (ctx.derived.has(c.field)) {
      throw new XpathError(`derived value "${c.field}" is yes/no; "${c.op}" cannot compare it to a number`);
    }
    const f = ref(c.field);
    const cmp = c.op === "at_least" ? ">=" : "<";
    return `(${f} != '' and ${f} ${cmp} ${formatNumber(c.value)})`;
  }
  const [kids, joiner] = "all" in c ? [c.all, " and "] : [c.any, " or "];
  if (kids.length === 0) throw new XpathError("all/any must have at least one condition");
  return `(${kids.map((k) => emit(k, ctx)).join(joiner)})`;
}

export function derivedCalculation(definition: Condition, ctx: XpathContext): string {
  return `if(${conditionToXpath(definition, ctx)}, 'yes', 'no')`;
}

export interface RuleLike {
  priority: number;
  when: Condition | "otherwise";
  outcome: string;
}

const quote = (id: string): string => {
  if (id.includes("'")) throw new XpathError(`id must not contain a quote: ${id}`);
  return `'${id}'`;
};

/** One nested if() in ascending priority; the "otherwise" rule is the final else. */
export function outcomeCalculation(rules: readonly RuleLike[], ctx: XpathContext): string {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  const otherwise = sorted.filter((r) => r.when === "otherwise");
  if (otherwise.length !== 1) {
    throw new XpathError(`exactly one "otherwise" rule is required, found ${otherwise.length}`);
  }
  const last = sorted[sorted.length - 1] as RuleLike;
  if (last.when !== "otherwise") throw new XpathError('the "otherwise" rule must have the highest priority');
  let expr = quote(last.outcome);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const r = sorted[i] as RuleLike;
    expr = `if(${conditionToXpath(r.when as Condition, ctx)}, ${quote(r.outcome)}, ${expr})`;
  }
  return expr;
}

export function constraintXpath(min: number, max: number): string {
  return `. >= ${formatNumber(min)} and . <= ${formatNumber(max)}`;
}

/** age_months_min <= age < age_months_below, using the same emission as at_least / less_than. */
export function ageBandXpath(ageField: string, min: number, below: number): string {
  const f = ref(ageField);
  return `(${f} != '' and ${f} >= ${formatNumber(min)}) and (${f} != '' and ${f} < ${formatNumber(below)})`;
}

export function outcomeRelevant(outcomeId: string): string {
  return `\${outcome} = ${quote(outcomeId)}`;
}
