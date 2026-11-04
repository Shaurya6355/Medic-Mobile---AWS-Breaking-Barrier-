import { EvalError, DerivedCycleError, evaluate } from "../logic/interpreter.js";
import type { Answers } from "../logic/interpreter.js";
import { allMatches } from "../logic/interpreter.js";
import { analyzeRules, enumerateAnswers } from "../logic/grid.js";
import type { RuleAnalysis } from "../logic/grid.js";
import type { Model } from "../logic/schema.js";

export const DEFAULT_MAX_POINTS = 200000;

export interface Analysis {
  maxPoints: number;
  /** Set when the analysis could not run at all (a broken reference, a loop between calculated values). */
  failure?: string;
  /** True only when every combination of answers within the entry limits was gone through. */
  exact: boolean;
  /** Plain-language reason when exact is false. */
  inexactReason?: string;
  points: Answers[];
  /** The rules end with a catch-all that is checked last. */
  closed: boolean;
  /** Present when the table is closed and the analysis ran: per rule and per result counts, severity inversions. */
  rules?: RuleAnalysis;
  /** For each rule that applies somewhere without being first: the first such combination and the rule that decided instead. */
  shadow: Map<string, { example: Answers; winner: string }>;
  /** For each severity inversion "firstRule|hiddenRule": the simplest example child found (fewest "yes" answers). */
  inversionExamples: Map<string, Answers>;
  /** Combinations that no rule answers (only possible when the table is not closed). */
  uncovered: { count: number; example?: Answers };
  /** How many combinations made each calculated value yes and no. */
  derivedSeen: Map<string, { yes: number; no: number }>;
  /** How many combinations asked each question. */
  shown: Map<string, number>;
}

const yesCount = (p: Answers): number => Object.values(p).filter((v) => v === true).length;

export function isClosed(model: Model): boolean {
  const sorted = [...model.rules].sort((a, b) => a.priority - b.priority);
  const others = sorted.filter((r) => r.when === "otherwise");
  return others.length === 1 && sorted[sorted.length - 1]?.when === "otherwise";
}

function plainFailure(e: unknown): string {
  if (e instanceof DerivedCycleError) return "some calculated values depend on each other in a circle, so they cannot be worked out";
  if (e instanceof EvalError) return "the draft refers to a question or calculated value that does not exist";
  return "the draft could not be worked through (" + (e instanceof Error ? e.message : "unknown problem") + ")";
}

function bigNumber(n: number): string {
  if (n >= 1e12) return "far more than a trillion";
  return String(Math.round(n));
}

/**
 * Cache: one analysis per model object and limit, shared by every logic check in a run.
 * Keyed on the object identity, so a model that is changed in place after it was analysed
 * must be copied first (the editor always makes a new snapshot, which is a new object).
 */
const cache = new WeakMap<Model, Map<number, Analysis>>();

export function getAnalysis(model: Model, maxPoints: number = DEFAULT_MAX_POINTS): Analysis {
  let perLimit = cache.get(model);
  if (perLimit === undefined) {
    perLimit = new Map();
    cache.set(model, perLimit);
  }
  const hit = perLimit.get(maxPoints);
  if (hit !== undefined) return hit;
  const a = compute(model, maxPoints);
  perLimit.set(maxPoints, a);
  return a;
}

function compute(model: Model, maxPoints: number): Analysis {
  const base: Analysis = {
    maxPoints,
    exact: false,
    points: [],
    closed: isClosed(model),
    uncovered: { count: 0 },
    shadow: new Map(),
    inversionExamples: new Map(),
    derivedSeen: new Map(model.derived.map((d) => [d.id, { yes: 0, no: 0 }])),
    shown: new Map(model.questions.map((q) => [q.id, 0])),
  };
  const prio = new Map(model.rules.map((r) => [r.id, r.priority]));
  const sev = new Map(model.outcomes.map((o) => [o.id, o.severity]));
  const ruleOutcome = new Map(model.rules.map((r) => [r.id, r.outcome]));
  try {
    const grid = enumerateAnswers(model, { maxPoints });
    base.points = grid.points;
    base.exact = grid.exact;
    if (!grid.exact) {
      base.inexactReason = `there are about ${bigNumber(grid.estimated)} combinations of answers, more than the ${maxPoints} that can be checked one by one`;
    }
    for (const p of grid.points) {
      for (const q of model.questions) if (p[q.id] !== undefined) base.shown.set(q.id, (base.shown.get(q.id) ?? 0) + 1);
    }
    if (base.closed) {
      base.rules = analyzeRules(model, { maxPoints });
      for (const p of grid.points) {
        const e = evaluate(model, p, { allowMissing: true });
        for (const [id, v] of Object.entries(e.derived)) {
          const c = base.derivedSeen.get(id);
          if (c === undefined) continue;
          if (v) c.yes++;
          else c.no++;
        }
        const here = yesCount(p);
        for (const id of allMatches(model, p, { allowMissing: true })) {
          if (id === e.rule) continue;
          // Shadow example: the nearest rule above (highest priority number below this rule's), then the simplest child.
          const prev = base.shadow.get(id);
          const winnerPrio = prio.get(e.rule) as number;
          const prevPrio = prev === undefined ? -Infinity : (prio.get(prev.winner) as number);
          if (prev === undefined || winnerPrio > prevPrio || (winnerPrio === prevPrio && here < yesCount(prev.example))) {
            base.shadow.set(id, { example: p, winner: e.rule });
          }
          if ((sev.get(ruleOutcome.get(id) as string) as number) < e.severity) {
            const key = `${e.rule}|${id}`;
            const old = base.inversionExamples.get(key);
            if (old === undefined || here < yesCount(old)) base.inversionExamples.set(key, p);
          }
        }
      }
    } else {
      for (const p of grid.points) {
        if (allMatches(model, p, { allowMissing: true }).length === 0) {
          base.uncovered.count++;
          base.uncovered.example ??= p;
        }
      }
    }
  } catch (e) {
    base.failure = plainFailure(e);
    base.exact = false;
  }
  return base;
}

/** Why nothing is proven, in plain words, or undefined when the whole grid was gone through. */
export function notProvenReason(a: Analysis): string | undefined {
  return a.failure ?? (a.exact ? undefined : a.inexactReason);
}
