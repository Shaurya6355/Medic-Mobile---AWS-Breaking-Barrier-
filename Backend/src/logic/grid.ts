import type { Answers } from "./interpreter.js";
import { allMatches, evalCondition, evaluate } from "./interpreter.js";
import type { Condition, Model } from "./schema.js";

export interface Enumeration {
  points: Answers[];
  exact: boolean;
  /** Upper bound on the full grid size (product of candidate counts); equals points.length when exact. */
  estimated: number;
  reasons: string[];
}

function thresholds(c: Condition, out: Map<string, Set<number>>): void {
  const stack: Condition[] = [c];
  while (stack.length) {
    const x = stack.pop() as Condition;
    if ("field" in x) {
      if (x.op !== "is_yes") {
        if (!out.has(x.field)) out.set(x.field, new Set());
        out.get(x.field)!.add(x.value);
      }
    } else stack.push(...("all" in x ? x.all : x.any));
  }
}

/**
 * Candidate values per integer question.
 *
 * Why this is exact: the only integer atoms are `at_least t` and `less_than t`. Each cuts the
 * integers at the boundary between t-1 and t, so the thresholds partition the integer line into
 * intervals on which every atom is constant. Every interval contains t or t-1 for some
 * threshold t, or is an unbounded end (represented by the constraint min or max, or by the
 * extreme t / t-1 when there is no constraint). Values clipped out of the constraint range are
 * not valid inputs, so dropping them loses no region. Fractional thresholds are handled too:
 * the integers ceil(t) and ceil(t)-1 are the boundary values, so we use those.
 */
function candidates(model: Model): Map<string, number[]> {
  const th = new Map<string, Set<number>>();
  for (const q of model.questions) if (q.shown_when) thresholds(q.shown_when, th);
  for (const d of model.derived) thresholds(d.definition, th);
  for (const r of model.rules) if (r.when !== "otherwise") thresholds(r.when, th);
  const out = new Map<string, number[]>();
  for (const q of model.questions) {
    if (q.answer_type !== "integer") continue;
    const set = new Set<number>();
    for (const t of th.get(q.id) ?? []) {
      const b = Math.ceil(t);
      set.add(b);
      set.add(b - 1);
    }
    if (q.constraint) {
      set.add(q.constraint.min);
      set.add(q.constraint.max);
    }
    let vals = [...set].filter((v) => !q.constraint || (v >= q.constraint.min && v <= q.constraint.max));
    if (vals.length === 0) vals = [q.constraint ? q.constraint.min : 0];
    out.set(q.id, vals.sort((a, b) => a - b));
  }
  return out;
}

export function enumerateAnswers(model: Model, opts: { maxPoints?: number } = {}): Enumeration {
  const maxPoints = opts.maxPoints ?? 200000;
  const cand = candidates(model);
  const ids = new Set(model.questions.map((q) => q.id));
  let estimated = 1;
  for (const q of model.questions) {
    estimated *= q.answer_type === "yes_no" ? 2 : (cand.get(q.id) as number[]).length;
    if (!Number.isFinite(estimated)) estimated = Number.MAX_VALUE;
  }
  const points: Answers[] = [];
  let truncated = false;

  const walk = (i: number, cur: Answers): void => {
    if (truncated) return;
    if (i === model.questions.length) {
      if (points.length >= maxPoints) {
        truncated = true;
        return;
      }
      points.push({ ...cur });
      return;
    }
    const q = model.questions[i]!;
    const shown = q.shown_when === undefined || evalCondition(q.shown_when, cur, ids, `questions.${q.id}.shown_when`);
    if (!shown) {
      walk(i + 1, cur);
      return;
    }
    const vals: Array<number | boolean> = q.answer_type === "yes_no" ? [true, false] : (cand.get(q.id) as number[]);
    for (const v of vals) {
      cur[q.id] = v;
      walk(i + 1, cur);
      if (truncated) break;
    }
    delete cur[q.id];
  };
  walk(0, {});

  if (truncated) {
    return {
      points,
      exact: false,
      estimated,
      reasons: [`full grid exceeds maxPoints (${maxPoints}); only the first ${maxPoints} points were enumerated`],
    };
  }
  return { points, exact: true, estimated: points.length, reasons: [] };
}

export interface SeverityInversion {
  firstRule: string;
  firstOutcome: string;
  firstSeverity: number;
  overriddenRule: string;
  overriddenOutcome: string;
  overriddenSeverity: number;
  example: Answers;
}

export interface RuleAnalysis {
  exact: boolean;
  points: number;
  perRule: Record<string, { first: number; matched: number; example?: Answers }>;
  perOutcome: Record<string, number>;
  /** Rules that are never the first match (first === 0), only reported when the grid is exact. */
  unreachableRules: string[];
  /** Subset of the above that do hold at some point but are always preempted. */
  neverFirstButMatching: string[];
  uncoveredByAnyRule: number;
  /**
   * Places where the rule that fires first has a LESS urgent outcome (higher severity number)
   * than a later rule that also holds. One entry per (first rule, overridden rule) pair,
   * with the first example found. Lower severity number = more urgent.
   */
  severityInversions: SeverityInversion[];
}

export function analyzeRules(model: Model, opts: { maxPoints?: number } = {}): RuleAnalysis {
  const grid = enumerateAnswers(model, opts);
  const sev = new Map(model.outcomes.map((o) => [o.id, o.severity]));
  const ruleOutcome = new Map(model.rules.map((r) => [r.id, r.outcome]));
  const perRule: RuleAnalysis["perRule"] = {};
  for (const r of model.rules) perRule[r.id] = { first: 0, matched: 0 };
  const perOutcome: Record<string, number> = {};
  for (const o of model.outcomes) perOutcome[o.id] = 0;
  const inversions = new Map<string, SeverityInversion>();
  let uncovered = 0;

  for (const point of grid.points) {
    const e = evaluate(model, point, { allowMissing: true });
    const matches = allMatches(model, point, { allowMissing: true });
    if (matches.length === 0) uncovered++;
    for (const id of matches) perRule[id]!.matched++;
    const first = perRule[e.rule]!;
    first.first++;
    first.example ??= point;
    perOutcome[e.outcome] = (perOutcome[e.outcome] ?? 0) + 1;
    for (const id of matches) {
      if (id === e.rule) continue;
      const os = sev.get(ruleOutcome.get(id) as string) as number;
      if (os < e.severity) {
        const key = `${e.rule}|${id}`;
        if (!inversions.has(key)) {
          inversions.set(key, {
            firstRule: e.rule,
            firstOutcome: e.outcome,
            firstSeverity: e.severity,
            overriddenRule: id,
            overriddenOutcome: ruleOutcome.get(id) as string,
            overriddenSeverity: os,
            example: point,
          });
        }
      }
    }
  }

  const never = model.rules.filter((r) => perRule[r.id]!.first === 0).map((r) => r.id);
  return {
    exact: grid.exact,
    points: grid.points.length,
    perRule,
    perOutcome,
    unreachableRules: grid.exact ? never : [],
    neverFirstButMatching: never.filter((id) => perRule[id]!.matched > 0),
    uncoveredByAnyRule: uncovered,
    severityInversions: [...inversions.values()],
  };
}
