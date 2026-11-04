import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import { describeChild, exampleOf } from "../child.js";
import { openQuestionSubject, outcomeSubject, questionSubject, ruleSubject, scopeSubject, followUpSubject } from "../describe.js";
import { evaluate } from "../../logic/interpreter.js";
import type { Answers } from "../../logic/interpreter.js";
import type { Condition, Model, OpenQuestion, Outcome, Question, Rule } from "../../logic/schema.js";
import { clip } from "../text.js";
import { citation } from "./common.js";

export const CHECK = "crossCheck";

/**
 * Independent cross-check (system design S3). A second logic model, drafted separately, is compared with the one being
 * checked, by code only; nothing here decides which of the two is right (design rule: the model never decides).
 *
 * What is compared, matched by id first and then by the words of the label (never by position):
 *  - structure: the age range, each question (kind of answer, unit, entry limits), the cut-off numbers used for each
 *    question, each result (urgency rank, follow-up, actions, doses by age) and the open questions each draft raised;
 *  - behaviour: both drafts are run through the one interpreter over the same combinations of answers (every
 *    question of either draft, split at every cut-off of either draft). Combinations that get different results are
 *    grouped by pair of results, each shown with one example child and the rules that decided in each draft.
 *
 * Everything is a WARNING decided by the clinician (nothing blocks signing: a weaker second draft must not stall the
 * pathway), shown to both roles. Without ctx.crossCheck the check is silent and contextNotice says it did not run.
 * Agreement proves nothing about the booklet; two drafts can share the same mistake.
 */

type Aud = ("clinician" | "program_officer")[];
const BOTH: Aud = ["clinician", "program_officer"];
// Each draft's result is remembered per set of its own answers, so a large shared set of combinations stays cheap.
const DEFAULT_MAX_POINTS = 2000000;
const MAX_EXAMPLES_TEXT = 300;

function warning(code: string, subjects: Subject[], params: Record<string, string | number | boolean>, source: { page: number; quote: string }[], example?: Record<string, number | boolean>): Finding {
  return makeFinding({
    check: CHECK,
    code,
    severity: "warning",
    audience: BOTH,
    decidedBy: "clinician",
    subjects,
    params,
    source,
    ...(example !== undefined ? { example } : {}),
  });
}

function info(code: string, params: Record<string, string | number | boolean>): Finding {
  return makeFinding({
    check: CHECK,
    code,
    severity: "info",
    audience: BOTH,
    decidedBy: "clinician",
    subjects: [{ kind: "document", id: "cross-check" }],
    params,
    source: [],
  });
}

// ---------- text helpers ----------
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Everyday words that carry no clinical meaning; "not" and "no" are kept because they reverse one. */
const STOP = new Set(["is", "are", "the", "a", "an", "of", "to", "for", "in", "if", "does", "do", "did", "has", "have", "had", "there", "child", "look", "ask", "by", "on", "or", "and", "with", "this", "that", "it"]);
const words = (s: string): Set<string> => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)));

/** Dice coefficient of the word sets of two texts, 0 to 1. */
function dice(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return (2 * common) / (x.size + y.size);
}

const unitWords = (u: string | undefined): string => (u === undefined ? "" : ` ${u.replace(/_/g, " ")}`);
const answerKind = (q: Question): string => (q.answer_type === "yes_no" ? "yes or no" : `a whole number${unitWords(q.unit)}`);
const monthsText = (n: number): string => `${n} month${n === 1 ? "" : "s"}`;

// ---------- matching ----------
type Match<T> = { pairs: Array<[T, T]>; onlyFirst: T[]; onlySecond: T[] };

/** Pairs items by id, then the leftovers by identical label words. Deterministic: first-draft order. */
function matchItems<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[],
  label: (x: T) => string,
  /** Score above 0 for a leftover pair that is probably the same item; the best scores pair first. */
  similarity?: (a: T, b: T, leftFirst: readonly T[], leftSecond: readonly T[]) => number,
): Match<T> {
  const pairs: Array<[T, T]> = [];
  const usedSecond = new Set<T>();
  const left: T[] = [];
  for (const a of first) {
    const b = second.find((x) => x.id === a.id && !usedSecond.has(x));
    if (b !== undefined) {
      pairs.push([a, b]);
      usedSecond.add(b);
    } else left.push(a);
  }
  const onlyFirst: T[] = [];
  for (const a of left) {
    const key = norm(label(a));
    const b = second.find((x) => !usedSecond.has(x) && norm(label(x)) === key);
    if (b !== undefined && key !== "") {
      pairs.push([a, b]);
      usedSecond.add(b);
    } else onlyFirst.push(a);
  }
  let onlySecond = second.filter((x) => !usedSecond.has(x));
  if (similarity !== undefined && onlyFirst.length > 0 && onlySecond.length > 0) {
    const cands: Array<[number, number, number]> = [];
    onlyFirst.forEach((a, i) => onlySecond.forEach((b, j) => {
      const sc = similarity(a, b, onlyFirst, onlySecond);
      if (sc > 0) cands.push([sc, i, j]);
    }));
    cands.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const takenFirst = new Set<number>();
    const takenSecond = new Set<number>();
    for (const [, i, j] of cands) {
      if (takenFirst.has(i) || takenSecond.has(j)) continue;
      takenFirst.add(i);
      takenSecond.add(j);
      pairs.push([onlyFirst[i] as T, onlySecond[j] as T]);
    }
    const stillFirst = onlyFirst.filter((_, i) => !takenFirst.has(i));
    onlySecond = onlySecond.filter((_, j) => !takenSecond.has(j));
    return { pairs, onlyFirst: stillFirst, onlySecond };
  }
  return { pairs, onlyFirst, onlySecond };
}

/** Questions that are probably the same: same kind of answer and mostly the same clinical words, or the only whole-number question in the same unit on each side. */
function questionSimilarity(a: Question, b: Question, leftFirst: readonly Question[], leftSecond: readonly Question[]): number {
  if (a.answer_type !== b.answer_type) return 0;
  const d = dice(a.label, b.label);
  if (d >= 0.6) return d;
  const sameUnit = (q: Question): boolean => q.answer_type === "integer" && q.unit !== undefined && q.unit === a.unit;
  return a.answer_type === "integer" && a.unit !== undefined && a.unit === b.unit && leftFirst.filter(sameUnit).length === 1 && leftSecond.filter(sameUnit).length === 1 ? 0.5 : 0;
}

// ---------- cut-offs ----------
type Atom = { field: string; op: "at_least" | "less_than"; value: number };

function atoms(model: Model): Atom[] {
  const out: Atom[] = [];
  const visit = (c: Condition): void => {
    const stack: Condition[] = [c];
    while (stack.length > 0) {
      const x = stack.pop() as Condition;
      if ("field" in x) {
        if (x.op !== "is_yes") out.push({ field: x.field, op: x.op, value: x.value });
      } else stack.push(...("all" in x ? x.all : x.any));
    }
  };
  for (const q of model.questions) if (q.shown_when !== undefined) visit(q.shown_when);
  for (const d of model.derived) visit(d.definition);
  for (const r of model.rules) if (r.when !== "otherwise") visit(r.when);
  return out;
}

/** Cut-off numbers per question id, as "at_least 50" style keys. */
function cutoffsByQuestion(model: Model, rename: (id: string) => string | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of atoms(model)) {
    const id = rename(a.field);
    if (id === undefined) continue;
    const set = out.get(id) ?? new Set<string>();
    set.add(`${a.op} ${a.value}`);
    out.set(id, set);
  }
  return out;
}

function cutoffText(keys: Iterable<string>): string {
  const parsed = [...keys].map((k) => {
    const [op, v] = k.split(" ") as ["at_least" | "less_than", string];
    return { op, value: Number(v) };
  });
  parsed.sort((a, b) => a.value - b.value || (a.op < b.op ? -1 : 1));
  return parsed.length === 0 ? "none" : parsed.map((p) => (p.op === "at_least" ? `${p.value} or more` : `less than ${p.value}`)).join(", ");
}

// ---------- outcome details ----------
function followUpText(o: Outcome): string {
  const f = o.follow_up;
  if (f === null) return "no follow-up";
  const due = f.kind === "on_return" ? "due when the child comes back" : f.due_in_days === null ? "due on a day not stated" : `due after ${f.due_in_days} day${f.due_in_days === 1 ? "" : "s"}`;
  const open = f.task_window_days_after_due === null ? "" : `, open for ${f.task_window_days_after_due} more day${f.task_window_days_after_due === 1 ? "" : "s"}`;
  return due + open;
}

function doseText(a: Outcome["actions"][number]): string {
  const d = a.dose_by_age;
  if (d === undefined || d.length === 0) return "no dose by age";
  return [...d]
    .sort((x, y) => x.age_months_min - y.age_months_min || x.age_months_below - y.age_months_below)
    .map((x) => `${x.age_months_min} up to ${x.age_months_below} months: ${x.dose}${x.total === undefined ? "" : ` (${x.total})`}`)
    .join("; ");
}

const listText = (xs: string[]): string => (xs.length === 0 ? "none" : clip(xs.map((x) => `"${clip(x, 80)}"`).join("; "), MAX_EXAMPLES_TEXT));

// ---------- the check ----------
export function crossCheck(ctx: CheckContext): Finding[] {
  const input = ctx.crossCheck;
  if (input === undefined) return [];
  if ("invalid" in input) {
    const issues = input.invalid;
    return [
      warning(
        "CROSS_CHECK_SECOND_DRAFT_INVALID",
        [{ kind: "document", id: "cross-check" }],
        { issue: clip(issues[0] ?? "the file could not be read", 200), count: Math.max(1, issues.length) },
        [],
      ),
    ];
  }
  const A = ctx.model;
  const B = input.model;
  const out: Finding[] = [];

  // --- age range
  if (A.scope.age_months_min !== B.scope.age_months_min || A.scope.age_months_below !== B.scope.age_months_below) {
    const c = citation(A.scope);
    out.push(
      warning(
        "CROSS_CHECK_SCOPE_DIFFERS",
        [scopeSubject],
        { firstFrom: A.scope.age_months_min, firstTo: A.scope.age_months_below, secondFrom: B.scope.age_months_min, secondTo: B.scope.age_months_below, ...c.params },
        c.source,
      ),
    );
  }

  // --- questions
  const qm = matchItems(A.questions, B.questions, (q) => q.label, questionSimilarity);
  const bToA = new Map<string, string>();
  const compatible = new Map<string, Question>(); // first-draft id -> second-draft question, same kind of answer
  for (const [a, b] of qm.pairs) {
    bToA.set(b.id, a.id);
    if (a.answer_type === b.answer_type) compatible.set(a.id, b);
  }
  for (const [draft, list] of [["first", qm.onlyFirst], ["second", qm.onlySecond]] as const) {
    for (const q of list) {
      const c = citation(q);
      out.push(warning("CROSS_CHECK_QUESTION_ONLY_IN_ONE", [questionSubject(q)], { draft, question: clip(q.label, 120), answerKind: answerKind(q), ...c.params }, c.source));
    }
  }
  for (const [a, b] of qm.pairs) {
    const diffs: string[] = [];
    if (a.answer_type !== b.answer_type) diffs.push(`the kind of answer (first: ${answerKind(a)}; second: ${answerKind(b)})`);
    if ((a.unit ?? "") !== (b.unit ?? "") && a.answer_type === b.answer_type) diffs.push(`the unit (first: ${a.unit ?? "none"}; second: ${b.unit ?? "none"})`);
    if (a.required !== b.required) diffs.push(`whether it must be answered (first: ${a.required ? "yes" : "no"}; second: ${b.required ? "yes" : "no"})`);
    const la = a.constraint === undefined ? "no limits" : `${a.constraint.min} to ${a.constraint.max}`;
    const lb = b.constraint === undefined ? "no limits" : `${b.constraint.min} to ${b.constraint.max}`;
    if (la !== lb) diffs.push(`the answers allowed (first: ${la}; second: ${lb})`);
    if (diffs.length > 0) {
      const c = citation(a);
      out.push(warning("CROSS_CHECK_QUESTION_DIFFERS", [questionSubject(a)], { question: clip(a.label, 120), differences: diffs.join("; "), ...c.params }, c.source));
    }
  }

  // --- cut-off numbers used for each matched question
  const firstCut = cutoffsByQuestion(A, (id) => id);
  const secondCut = cutoffsByQuestion(B, (id) => bToA.get(id));
  for (const [a] of qm.pairs) {
    const x = firstCut.get(a.id) ?? new Set<string>();
    const y = secondCut.get(a.id) ?? new Set<string>();
    if (x.size === y.size && [...x].every((k) => y.has(k))) continue;
    const c = citation(a);
    out.push(warning("CROSS_CHECK_CUTOFF_DIFFERS", [questionSubject(a)], { question: clip(a.label, 120), first: cutoffText(x), second: cutoffText(y), ...c.params }, c.source));
  }

  // --- results (outcomes)
  const om = matchItems(A.outcomes, B.outcomes, (o) => o.title);
  const outcomeBToA = new Map<string, string>(om.pairs.map(([a, b]) => [b.id, a.id]));
  for (const [draft, list] of [["first", om.onlyFirst], ["second", om.onlySecond]] as const) {
    for (const o of list) {
      const c = citation(o);
      out.push(warning("CROSS_CHECK_OUTCOME_ONLY_IN_ONE", [outcomeSubject(o)], { draft, outcome: clip(o.title, 120), severity: o.severity, ...c.params }, c.source));
    }
  }
  for (const [a, b] of om.pairs) {
    const c = citation(a);
    if (a.severity !== b.severity) {
      const direction = b.severity > a.severity ? "less_urgent_in_second" : "more_urgent_in_second";
      out.push(warning("CROSS_CHECK_SEVERITY_DIFFERS", [outcomeSubject(a)], { outcome: clip(a.title, 120), firstSeverity: a.severity, secondSeverity: b.severity, direction, ...c.params }, c.source));
    }
    if (followUpText(a) !== followUpText(b)) {
      const fc = citation(a.follow_up ?? b.follow_up ?? {});
      out.push(warning("CROSS_CHECK_FOLLOWUP_DIFFERS", [followUpSubject(a)], { outcome: clip(a.title, 120), first: followUpText(a), second: followUpText(b), ...fc.params }, fc.source));
    }
    // actions: identical words first, then the closest wording; a leftover on either side is a difference
    const am = matchActions(a.actions, b.actions);
    if (am.onlyFirst.length > 0 || am.onlySecond.length > 0) {
      const ac = citation(am.onlyFirst.find((x) => (x.source ?? []).length > 0) ?? am.onlySecond.find((x) => (x.source ?? []).length > 0) ?? a);
      out.push(
        warning(
          "CROSS_CHECK_ACTION_DIFFERS",
          [outcomeSubject(a)],
          { outcome: clip(a.title, 120), onlyFirst: listText(am.onlyFirst.map((x) => x.text)), onlySecond: listText(am.onlySecond.map((x) => x.text)), ...ac.params },
          ac.source,
        ),
      );
    }
    for (const [x, y] of am.pairs) {
      if (doseText(x) !== doseText(y)) {
        const dc = citation((x.source ?? []).length > 0 ? x : a);
        out.push(
          warning("CROSS_CHECK_DOSE_DIFFERS", [outcomeSubject(a)], { outcome: clip(a.title, 120), action: clip(x.text, 120), first: doseText(x), second: doseText(y), ...dc.params }, dc.source),
        );
      }
    }
  }

  // --- open questions: an ambiguity only one draft saw still goes to a person
  const oq = matchOpenQuestions(A.open_questions, B.open_questions);
  for (const [draft, list] of [["first", oq.onlyFirst], ["second", oq.onlySecond]] as const) {
    for (const q of list) {
      const c = citation(q);
      out.push(warning("CROSS_CHECK_OPEN_QUESTION_ONLY_IN_ONE", [openQuestionSubject(q)], { draft, question: clip(q.question, 300), route: q.route_to, ...c.params }, c.source));
    }
  }

  // --- behaviour: both drafts through the one interpreter over the same combinations of answers
  out.push(...behaviour(ctx, A, B, compatible, outcomeBToA));
  return out;
}

function matchActions(first: Outcome["actions"], second: Outcome["actions"]): { pairs: Array<[Outcome["actions"][number], Outcome["actions"][number]]>; onlyFirst: Outcome["actions"]; onlySecond: Outcome["actions"] } {
  type A = Outcome["actions"][number];
  const pairs: Array<[A, A]> = [];
  const used = new Set<A>();
  const left: A[] = [];
  for (const a of first) {
    const b = second.find((x) => !used.has(x) && norm(x.text) === norm(a.text));
    if (b !== undefined) {
      pairs.push([a, b]);
      used.add(b);
    } else left.push(a);
  }
  const onlyFirst: A[] = [];
  for (const a of left) {
    let best: A | undefined;
    let bestScore = 0.7;
    for (const x of second) {
      if (used.has(x)) continue;
      const s = dice(a.text, x.text);
      if (s >= bestScore) {
        best = x;
        bestScore = s;
      }
    }
    if (best !== undefined) {
      pairs.push([a, best]);
      used.add(best);
    } else onlyFirst.push(a);
  }
  return { pairs, onlyFirst, onlySecond: second.filter((x) => !used.has(x)) };
}

function matchOpenQuestions(first: readonly OpenQuestion[], second: readonly OpenQuestion[]): { onlyFirst: OpenQuestion[]; onlySecond: OpenQuestion[] } {
  const used = new Set<OpenQuestion>();
  const onlyFirst: OpenQuestion[] = [];
  for (const a of first) {
    let best: OpenQuestion | undefined;
    let bestScore = 0.6;
    for (const x of second) {
      if (used.has(x)) continue;
      const s = dice(a.question, x.question);
      if (s >= bestScore) {
        best = x;
        bestScore = s;
      }
    }
    if (best !== undefined) used.add(best);
    else onlyFirst.push(a);
  }
  return { onlyFirst, onlySecond: second.filter((x) => !used.has(x)) };
}

// ---------- behaviour ----------
type Dim = { aId?: string; bId?: string; values: Array<number | boolean> };

function thresholdsOf(model: Model): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const a of atoms(model)) {
    const set = out.get(a.field) ?? new Set<number>();
    set.add(a.value);
    out.set(a.field, set);
  }
  return out;
}

/** Values to try for a whole-number question: both sides of every cut-off either draft uses, and the limits both allow. */
function integerValues(thresholds: Iterable<number>, limits: Array<Question["constraint"]>): number[] {
  const set = new Set<number>();
  for (const t of thresholds) {
    const b = Math.ceil(t);
    set.add(b);
    set.add(b - 1);
  }
  const real = limits.filter((l): l is NonNullable<Question["constraint"]> => l !== undefined);
  let lo = -Infinity;
  let hi = Infinity;
  for (const l of real) {
    set.add(l.min);
    set.add(l.max);
    lo = Math.max(lo, l.min);
    hi = Math.min(hi, l.max);
  }
  let vals = [...set].filter((v) => v >= lo && v <= hi);
  if (vals.length === 0) vals = [Number.isFinite(lo) ? lo : 0];
  return vals.sort((x, y) => x - y);
}

function behaviour(
  ctx: CheckContext,
  A: Model,
  B: Model,
  compatible: Map<string, Question>,
  outcomeBToA: Map<string, string>,
): Finding[] {
  const thA = thresholdsOf(A);
  const thB = thresholdsOf(B);
  const dims: Dim[] = [];
  const pairedB = new Set<string>();
  for (const q of A.questions) {
    const b = compatible.get(q.id);
    if (b !== undefined) pairedB.add(b.id);
    if (q.answer_type === "yes_no") dims.push({ aId: q.id, ...(b !== undefined ? { bId: b.id } : {}), values: [true, false] });
    else {
      const t = [...(thA.get(q.id) ?? []), ...(b !== undefined ? [...(thB.get(b.id) ?? [])] : [])];
      dims.push({ aId: q.id, ...(b !== undefined ? { bId: b.id } : {}), values: integerValues(t, [q.constraint, ...(b !== undefined ? [b.constraint] : [])]) });
    }
  }
  for (const q of B.questions) {
    if (pairedB.has(q.id)) continue;
    dims.push(
      q.answer_type === "yes_no"
        ? { bId: q.id, values: [true, false] }
        : { bId: q.id, values: integerValues(thB.get(q.id) ?? [], [q.constraint]) },
    );
  }

  const limit = ctx.maxGridPoints ?? DEFAULT_MAX_POINTS;
  let estimated = 1;
  for (const d of dims) {
    estimated *= d.values.length;
    if (estimated > limit) return [warning("CROSS_CHECK_NOT_COMPARED", [{ kind: "document", id: "cross-check" }], { combinations: estimated > 1e12 ? "far more than a trillion" : String(Math.round(estimated)) }, [])];
  }

  type Group = { count: number; a: ReturnType<typeof evaluate>; b: ReturnType<typeof evaluate>; answersA: Answers; answersB: Answers; score: number };
  const groups = new Map<string, Group>();
  let compared = 0;
  let differing = 0;
  let skipped = 0;
  const choice: Array<number | boolean> = new Array(dims.length);
  type Ev = ReturnType<typeof evaluate>;
  const memoA = new Map<string, Ev | null>();
  const memoB = new Map<string, Ev | null>();
  const evalOnce = (model: Model, memo: Map<string, Ev | null>, key: string, answers: Answers): Ev | null => {
    if (memo.has(key)) return memo.get(key) as Ev | null;
    let r: Ev | null;
    try {
      r = evaluate(model, answers, { allowMissing: true });
    } catch {
      r = null;
    }
    memo.set(key, r);
    return r;
  };

  const run = (): void => {
    const answersA: Answers = {};
    const answersB: Answers = {};
    let score = 0;
    let keyA = "";
    let keyB = "";
    dims.forEach((d, i) => {
      const v = choice[i] as number | boolean;
      if (v === true) score++;
      if (d.aId !== undefined) {
        answersA[d.aId] = v;
        keyA += `${String(v)}|`;
      }
      if (d.bId !== undefined) {
        answersB[d.bId] = v;
        keyB += `${String(v)}|`;
      }
    });
    const ea = evalOnce(A, memoA, keyA, answersA);
    const eb = evalOnce(B, memoB, keyB, answersB);
    if (ea === null || eb === null) {
      skipped++;
      return;
    }
    compared++;
    if (outcomeBToA.get(eb.outcome) === ea.outcome) return;
    differing++;
    const key = `${ea.outcome}|${eb.outcome}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { count: 1, a: ea, b: eb, answersA, answersB, score });
    else {
      g.count++;
      if (score < g.score) Object.assign(g, { a: ea, b: eb, answersA, answersB, score });
    }
  };
  const walk = (i: number): void => {
    if (i === dims.length) return run();
    for (const v of (dims[i] as Dim).values) {
      choice[i] = v;
      walk(i + 1);
    }
  };
  walk(0);

  const out: Finding[] = [];
  const ruleOf = (m: Model, id: string): Rule | undefined => m.rules.find((r) => r.id === id);
  const titleOf = (m: Model, id: string): string => m.outcomes.find((o) => o.id === id)?.title ?? id;
  for (const [, g] of [...groups].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const ra = ruleOf(A, g.a.rule);
    const rb = ruleOf(B, g.b.rule);
    const direction = g.b.severity > g.a.severity ? "less_urgent_in_second" : g.b.severity < g.a.severity ? "more_urgent_in_second" : "same_urgency";
    const secondOnly = B.questions.filter((q) => g.answersB[q.id] !== undefined && !dimsHasFirst(dims, q.id));
    const onlyInSecond = secondOnly.filter((q) => g.answersB[q.id] !== false).map((q) => `"${clip(q.label, 60)}" ${typeof g.answersB[q.id] === "boolean" ? "yes" : String(g.answersB[q.id])}`);
    const answeredNo = secondOnly.filter((q) => g.answersB[q.id] === false);
    // A few "no" answers are named (they may be what makes the difference); many are summed up.
    if (answeredNo.length > 0 && answeredNo.length <= 2) onlyInSecond.push(...answeredNo.map((q) => `"${clip(q.label, 60)}" no`));
    else if (answeredNo.length > 2) onlyInSecond.push("the other yes-or-no questions answered no");
    const c = ra === undefined ? { params: {}, source: [] as { page: number; quote: string }[] } : citation(ra);
    const source = [...c.source, ...(rb === undefined ? [] : citation(rb).source)];
    out.push(
      warning(
        "CROSS_CHECK_DISAGREEMENT",
        [...(ra === undefined ? [] : [ruleSubject(ra)]), outcomeSubject(A.outcomes.find((o) => o.id === g.a.outcome) as Outcome)],
        {
          child: describeChild(A, g.answersA),
          extra: onlyInSecond.join("; "),
          firstOutcome: titleOf(A, g.a.outcome),
          secondOutcome: titleOf(B, g.b.outcome),
          firstRule: g.a.rule,
          secondRule: g.b.rule,
          firstSeverity: g.a.severity,
          secondSeverity: g.b.severity,
          direction,
          count: g.count,
          total: compared,
          ...c.params,
        },
        source,
        exampleOf(g.answersA),
      ),
    );
  }
  out.push(info("CROSS_CHECK_SUMMARY", { compared, differing, skipped, groups: groups.size }));
  return out;
}

const dimsHasFirst = (dims: readonly Dim[], bId: string): boolean => dims.some((d) => d.bId === bId && d.aId !== undefined);
