import { enumerateAnswers } from "../logic/grid.js";
import { evaluate, type Answers } from "../logic/interpreter.js";
import type { Model } from "../logic/schema.js";

export interface BehaviourChange {
  answers: Answers;
  before: string;
  after: string;
}
export interface BehaviourDiff {
  truncated: boolean;
  changes: BehaviourChange[];
}

function outcomeOf(m: Model, a: Answers): string {
  try {
    return evaluate(m, a).outcome;
  } catch (e) {
    return `error:${e instanceof Error ? e.message : "unknown"}`;
  }
}

/** Compare outcomes of two models over the union of both models' enumerated answer grids. */
export function behaviourDiff(oldModel: Model, newModel: Model, opts: { maxPoints?: number } = {}): BehaviourDiff {
  const a = enumerateAnswers(oldModel, opts);
  const b = enumerateAnswers(newModel, opts);
  const seen = new Set<string>();
  const changes: BehaviourChange[] = [];
  for (const pt of [...a.points, ...b.points]) {
    const key = JSON.stringify(Object.entries(pt).sort(([x], [y]) => (x < y ? -1 : 1)));
    if (seen.has(key)) continue;
    seen.add(key);
    const before = outcomeOf(oldModel, pt);
    const after = outcomeOf(newModel, pt);
    if (before !== after) changes.push({ answers: pt, before, after });
  }
  return { truncated: !a.exact || !b.exact, changes };
}

/** Fails closed: truncated enumeration is never treated as preserving. */
export function isBehaviourPreserving(d: BehaviourDiff): boolean {
  return !d.truncated && d.changes.length === 0;
}
