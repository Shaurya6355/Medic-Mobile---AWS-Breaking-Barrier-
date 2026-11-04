import type { Condition, Model, Question } from "./schema.js";

export type Value = number | boolean;
export type Answers = Record<string, Value | undefined>;

export class AnswerError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid answers: ${issues.join("; ")}`);
    this.name = "AnswerError";
  }
}
export class MissingRequiredError extends Error {
  constructor(public readonly ids: string[]) {
    super(`missing required answers: ${ids.join(", ")}`);
    this.name = "MissingRequiredError";
  }
}
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalError";
  }
}
export class DerivedCycleError extends Error {
  constructor(public readonly ids: string[]) {
    super(`derived values form a cycle: ${ids.join(", ")}`);
    this.name = "DerivedCycleError";
  }
}

export type Reads = Record<string, Value | "absent">;

/**
 * Semantics: a condition is a total two-valued predicate. Any atom on an absent field is
 * false (is_yes, at_least and less_than alike), so `less_than` on absent is NOT the
 * complement of `at_least`. is_yes is true only for boolean true. A comparison on a boolean
 * value is false. all/any are classical. Every child is evaluated (no short circuit) so an
 * unknown field always throws and reads are complete.
 */
export function evalCondition(
  c: Condition,
  values: Answers,
  known: ReadonlySet<string>,
  path = "$",
  reads?: Reads,
): boolean {
  if ("field" in c) {
    if (!known.has(c.field)) throw new EvalError(`${path}: unknown field "${c.field}"`);
    // Own keys only: an inherited property (constructor, toString) is never an answer.
    const v = Object.hasOwn(values, c.field) ? values[c.field] : undefined;
    if (reads) reads[c.field] = v === undefined ? "absent" : v;
    if (v === undefined) return false;
    if (c.op === "is_yes") return v === true;
    if (typeof v !== "number") return false;
    return c.op === "at_least" ? v >= c.value : v < c.value;
  }
  const isAll = "all" in c;
  const kids = isAll ? c.all : c.any;
  const key = isAll ? "all" : "any";
  let acc = isAll;
  kids.forEach((k, i) => {
    const r = evalCondition(k, values, known, `${path}.${key}[${i}]`, reads);
    acc = isAll ? acc && r : acc || r;
  });
  return acc;
}

interface Prepared {
  questionIds: Set<string>;
  known: Set<string>;
  derivedOrder: Model["derived"];
  rules: Model["rules"];
  severity: Map<string, number>;
}
const cache = new WeakMap<Model, Prepared>();

function fieldsOf(c: Condition, out: Set<string>): void {
  const stack: Condition[] = [c];
  while (stack.length) {
    const x = stack.pop() as Condition;
    if ("field" in x) out.add(x.field);
    else stack.push(...("all" in x ? x.all : x.any));
  }
}

function prepare(model: Model): Prepared {
  const hit = cache.get(model);
  if (hit) return hit;
  const questionIds = new Set(model.questions.map((q) => q.id));
  const derivedIds = new Set(model.derived.map((d) => d.id));
  const known = new Set([...questionIds, ...derivedIds]);
  // Kahn's algorithm in declaration order: derived values read other derived values.
  const deps = new Map<string, Set<string>>();
  for (const d of model.derived) {
    const f = new Set<string>();
    fieldsOf(d.definition, f);
    deps.set(d.id, new Set([...f].filter((x) => derivedIds.has(x))));
  }
  const done = new Set<string>();
  const derivedOrder: Model["derived"] = [];
  let progressed = true;
  while (derivedOrder.length < model.derived.length && progressed) {
    progressed = false;
    for (const d of model.derived) {
      if (done.has(d.id)) continue;
      if ([...(deps.get(d.id) as Set<string>)].every((x) => done.has(x))) {
        done.add(d.id);
        derivedOrder.push(d);
        progressed = true;
      }
    }
  }
  if (derivedOrder.length < model.derived.length) {
    throw new DerivedCycleError(model.derived.filter((d) => !done.has(d.id)).map((d) => d.id));
  }
  const rules = [...model.rules].sort((a, b) => a.priority - b.priority);
  const severity = new Map(model.outcomes.map((o) => [o.id, o.severity]));
  const p = { questionIds, known, derivedOrder, rules, severity };
  cache.set(model, p);
  return p;
}

export interface EffectiveOptions {
  /** Treat shown, required, unanswered questions as absent instead of throwing. Grid analysis only. */
  allowMissing?: boolean;
}

function typeIssue(q: Question, v: unknown): string | undefined {
  if (q.answer_type === "yes_no") return typeof v === "boolean" ? undefined : `${q.id}: expected yes/no boolean`;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return `${q.id}: expected an integer`;
  return undefined;
}

/** Validate answers and drop those for questions whose shown_when is false. */
export function effectiveAnswers(model: Model, answers: Answers, opts: EffectiveOptions = {}): Answers {
  const p = prepare(model);
  const issues: string[] = [];
  for (const k of Object.keys(answers)) {
    if (!p.questionIds.has(k)) issues.push(`${k}: unknown question`);
  }
  // Null prototype: nothing is inherited, so a missing answer is reported as missing.
  const effective: Answers = Object.create(null) as Answers;
  const missing: string[] = [];
  for (const q of model.questions) {
    const supplied = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    if (supplied !== undefined) {
      const t = typeIssue(q, supplied);
      if (t) {
        issues.push(t);
        continue;
      }
    }
    const shown = q.shown_when === undefined || evalCondition(q.shown_when, effective, p.questionIds, `questions.${q.id}.shown_when`);
    if (!shown) continue;
    if (supplied === undefined) {
      if (q.required && !opts.allowMissing) missing.push(q.id);
      continue;
    }
    if (q.constraint && typeof supplied === "number" && (supplied < q.constraint.min || supplied > q.constraint.max)) {
      issues.push(`${q.id}: ${supplied} outside ${q.constraint.min}..${q.constraint.max}`);
      continue;
    }
    effective[q.id] = supplied;
  }
  if (issues.length > 0) throw new AnswerError(issues);
  if (missing.length > 0) throw new MissingRequiredError(missing);
  return effective;
}

function computeDerived(model: Model, effective: Answers): { derived: Record<string, boolean>; values: Answers } {
  const p = prepare(model);
  const values: Answers = Object.assign(Object.create(null) as Answers, effective);
  const derived: Record<string, boolean> = {};
  for (const d of p.derivedOrder) {
    const r = evalCondition(d.definition, values, p.known, `derived.${d.id}.definition`);
    derived[d.id] = r;
    values[d.id] = r;
  }
  return { derived, values };
}

export interface TraceEntry {
  rule: string;
  priority: number;
  matched: boolean;
  reads: Reads;
}
export interface Evaluation {
  outcome: string;
  severity: number;
  rule: string;
  derived: Record<string, boolean>;
  effective: Answers;
  trace: TraceEntry[];
}

function ruleHolds(when: Condition | "otherwise", values: Answers, known: ReadonlySet<string>, path: string, reads?: Reads): boolean {
  return when === "otherwise" ? true : evalCondition(when, values, known, path, reads);
}

export function evaluate(model: Model, answers: Answers, opts: EffectiveOptions = {}): Evaluation {
  const p = prepare(model);
  const effective = effectiveAnswers(model, answers, opts);
  const { derived, values } = computeDerived(model, effective);
  const trace: TraceEntry[] = [];
  for (const r of p.rules) {
    const reads: Reads = {};
    const matched = ruleHolds(r.when, values, p.known, `rules.${r.id}.when`, reads);
    trace.push({ rule: r.id, priority: r.priority, matched, reads });
    if (matched) {
      const severity = p.severity.get(r.outcome);
      if (severity === undefined) throw new EvalError(`rules.${r.id}: unknown outcome "${r.outcome}"`);
      return { outcome: r.outcome, severity, rule: r.id, derived, effective, trace };
    }
  }
  throw new EvalError("no rule matched (the model has no otherwise rule)");
}

/** Ids of every rule whose condition holds, in priority order (for shadow analysis). */
export function allMatches(model: Model, answers: Answers, opts: EffectiveOptions = {}): string[] {
  const p = prepare(model);
  const effective = effectiveAnswers(model, answers, opts);
  const { values } = computeDerived(model, effective);
  return p.rules.filter((r) => ruleHolds(r.when, values, p.known, `rules.${r.id}.when`)).map((r) => r.id);
}
