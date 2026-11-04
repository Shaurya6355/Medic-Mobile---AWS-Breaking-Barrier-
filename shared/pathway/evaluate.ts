/* The interpreter. The only place outcomes are computed, so the UI, the golden cases, the synthetic check
   and (later) the build-and-test step all agree. Semantics:
   - A hidden question (shown_when false) has no answer: null.
   - A leaf on a null value is false, for every operator.
   - Derived values are evaluated in dependency order; they are always yes or no.
   - Rules: first_match_by_priority. "otherwise" always matches. */
import { isLeaf, refs } from "./cond.ts";
import type { Answers, Cond, Spec } from "./types.ts";

export function evalCond(c: Cond, env: Answers): boolean {
  if (isLeaf(c)) {
    const v = env[c.field];
    if (v === null || v === undefined) return false;
    switch (c.op) {
      case "is_yes": return v === true;
      case "is_no": return v === false;
      case "at_least": return typeof v === "number" && v >= c.value!;
      case "at_most": return typeof v === "number" && v <= c.value!;
      case "less_than": return typeof v === "number" && v < c.value!;
      case "greater_than": return typeof v === "number" && v > c.value!;
      case "equals": return v === c.value;
    }
  }
  if ("all" in c) return c.all.every(x => evalCond(x, env));
  if ("any" in c) return c.any.some(x => evalCond(x, env));
  return !evalCond(c.not, env);
}

/** Derived ids in dependency order. Throws on a cycle (analyze reports it first). */
export function derivedOrder(spec: Spec): string[] {
  const byId = new Map(spec.derived.map(d => [d.id, d]));
  const out: string[] = [], state = new Map<string, 1 | 2>();
  const visit = (id: string, stack: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error("Derived values form a cycle: " + [...stack, id].join(" -> "));
    state.set(id, 1);
    refs(byId.get(id)!.definition).filter(r => byId.has(r)).forEach(r => visit(r, [...stack, id]));
    state.set(id, 2);
    out.push(id);
  };
  spec.derived.forEach(d => visit(d.id, []));
  return out;
}

export const byOrder = (spec: Spec) => spec.questions.slice().sort((a, b) => a.order - b.order);
export const byPriority = (spec: Spec) => spec.rules.slice().sort((a, b) => a.priority - b.priority);

export interface Result { outcome: string | null; rule: string | null; env: Answers }

/** The answers as the form would hold them: hidden questions blanked. */
export function visibleAnswers(spec: Spec, answers: Answers): Answers {
  const env: Answers = {};
  for (const q of byOrder(spec)) env[q.id] = !q.shown_when || evalCond(q.shown_when, env) ? (answers[q.id] ?? null) : null;
  return env;
}

export function evaluate(spec: Spec, answers: Answers): Result {
  const env = visibleAnswers(spec, answers);
  const defs = new Map(spec.derived.map(d => [d.id, d.definition]));
  for (const id of derivedOrder(spec)) env[id] = evalCond(defs.get(id)!, env);
  for (const r of byPriority(spec)) if (r.when === "otherwise" || evalCond(r.when, env)) return { outcome: r.outcome, rule: r.id, env };
  return { outcome: null, rule: null, env };
}
