import { evaluate } from "../../logic/interpreter.js";
import type { Answers } from "../../logic/interpreter.js";
import type { Condition, Model } from "../../logic/schema.js";
import { getAnalysis } from "../analysis.js";
import { describeChild } from "../child.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { questionSubject } from "../describe.js";
import { bandsOf, monthsQuestionId } from "./ageBands.js";
import { citation, outcomeTitle } from "./common.js";

export const CHECK = "boundaryCards";

export interface BoundaryCase {
  value: number;
  outcome: string;
  rule: string;
  derived: Record<string, boolean>;
}

export interface BoundaryCard {
  field: string;
  threshold: number;
  label: string;
  /** The child the card is about, with the tested question left out. */
  baseline: Answers;
  /** Results at threshold - 1, threshold and threshold + 1 (a value outside the entry limits is left out). */
  cases: BoundaryCase[];
}

type Use = { field: string; t: number; page?: number; quote?: string; source: { page: number; quote: string }[] };

function numberTests(c: Condition, out: Array<{ field: string; t: number }>): void {
  const stack: Condition[] = [c];
  while (stack.length > 0) {
    const x = stack.pop() as Condition;
    if ("field" in x) {
      if (x.op !== "is_yes") out.push({ field: x.field, t: Math.ceil(x.value) });
    } else stack.push(...("all" in x ? x.all : x.any));
  }
}

/** Every threshold of a whole-number question, in question order then ascending, with the first thing that cites the booklet for it. */
function thresholdsOf(model: Model): Map<string, Use> {
  const uses = new Map<string, Use>();
  const note = (tests: Array<{ field: string; t: number }>, src: Parameters<typeof citation>[0]): void => {
    for (const x of tests) {
      const key = `${x.field}|${x.t}`;
      const prev = uses.get(key);
      if (prev !== undefined && prev.source.length > 0) continue;
      uses.set(key, { field: x.field, t: x.t, source: citation(src).source });
    }
  };
  for (const d of model.derived) {
    const t: Array<{ field: string; t: number }> = [];
    numberTests(d.definition, t);
    note(t, d);
  }
  for (const r of model.rules) {
    if (r.when === "otherwise") continue;
    const t: Array<{ field: string; t: number }> = [];
    numberTests(r.when, t);
    note(t, r);
  }
  for (const q of model.questions) {
    if (q.shown_when === undefined) continue;
    const t: Array<{ field: string; t: number }> = [];
    numberTests(q.shown_when, t);
    note(t, q);
  }
  return uses;
}

/**
 * Boundary cards for the screen: for each whole-number threshold t of a question, the result at t-1, t and t+1
 * for one representative child. The child is the simplest combination (fewest "yes" answers, then first in
 * order) in which the question is asked and the three values do not all give the same result; if none exists,
 * one where a calculated value changes; else the simplest child asked the question. Everything else is held
 * fixed. Pure: the same model always gives the same cards.
 */
export function boundaryCards(model: Model, maxPoints?: number): BoundaryCard[] {
  const a = getAnalysis(model, maxPoints);
  if (a.failure !== undefined) return [];
  const uses = thresholdsOf(model);
  const cards: BoundaryCard[] = [];
  const score = (p: Answers): number => Object.values(p).filter((v) => v === true).length;
  const order = a.points.map((_, i) => i).sort((i, j) => score(a.points[i] as Answers) - score(a.points[j] as Answers) || i - j);
  const ageId = monthsQuestionId(model);
  const { age_months_min: scopeMin, age_months_below: scopeBelow } = model.scope;
  // A cut-off on any other question is shown for a child the form is meant for, not for a child outside the covered ages
  // (who is sent on by the age rules whatever the other answers are). The age question itself keeps every age.
  const insideScope = (p: Answers): boolean => {
    const v = ageId === undefined ? undefined : p[ageId];
    return typeof v !== "number" || (v >= scopeMin && v < scopeBelow);
  };
  const inScopeFirst = order.filter((i) => insideScope(a.points[i] as Answers));
  const scopeOrder = inScopeFirst.length > 0 ? [...inScopeFirst, ...order.filter((i) => !insideScope(a.points[i] as Answers))] : order;
  for (const q of model.questions) {
    if (q.answer_type !== "integer") continue;
    const candidates = q.id === ageId ? order : scopeOrder;
    const ts = [...new Set([...uses.values()].filter((u) => u.field === q.id).map((u) => u.t))].sort((x, y) => x - y);
    for (const t of ts) {
      const values = [t - 1, t, t + 1].filter((v) => !q.constraint || (v >= q.constraint.min && v <= q.constraint.max));
      const run = (base: Answers, v: number): BoundaryCase => {
        const e = evaluate(model, { ...base, [q.id]: v }, { allowMissing: true });
        return { value: v, outcome: e.outcome, rule: e.rule, derived: e.derived };
      };
      let pick: Answers | undefined;
      let derivedPick: Answers | undefined;
      let fallback: Answers | undefined;
      if (values.length === 3) {
        for (const i of candidates) {
          const p = a.points[i] as Answers;
          if (p[q.id] === undefined) continue;
          fallback ??= p;
          const rs = values.map((v) => run(p, v));
          if (new Set(rs.map((r) => r.outcome)).size > 1) {
            pick = p;
            break;
          }
          if (derivedPick === undefined && new Set(rs.map((r) => JSON.stringify(r.derived))).size > 1) derivedPick = p;
        }
      }
      const base = pick ?? derivedPick ?? fallback ?? {};
      const baseline: Answers = { ...base };
      delete baseline[q.id];
      cards.push({
        field: q.id,
        threshold: t,
        label: q.label,
        baseline,
        cases: values.length === 3 ? values.map((v) => run(base, v)) : [],
      });
    }
  }
  return cards;
}

/** One information finding per threshold; the screen shows the card itself (boundaryCards) next to it. */
export function boundaryCardsCheck(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const cards = boundaryCards(model, ctx.maxGridPoints);
  const uses = thresholdsOf(model);
  const months = monthsQuestionId(model);
  const bands = model.derived.flatMap((d) => (months === undefined ? [] : bandsOf(d.definition, months).map((b) => ({ ...b, id: d.id }))));
  const out: Finding[] = [];
  for (const card of cards) {
    if (card.cases.length !== 3) continue;
    const q = model.questions.find((x) => x.id === card.field);
    if (q === undefined) continue;
    const t = card.threshold;
    const meeting = card.field === months ? bands.filter((b) => b.hi === t && bands.some((o) => o.lo === t)) : [];
    const bandsMeet = meeting.length > 0;
    const meetingIds = new Set(bands.filter((b) => b.hi === t || b.lo === t).map((b) => b.id));
    // Only an open question about this very cut-off is named: one that opens with another number is about another edge.
    const openQ = bandsMeet ? openQuestionFor(model, meetingIds, t) : undefined;
    const unit = q.unit === undefined ? "" : ` ${q.unit.replace(/_/g, " ")}`;
    const withUnit = (v: number): string => `${v}${v === 1 ? singular(unit) : unit}`;
    const [c1, c2, c3] = card.cases as [BoundaryCase, BoundaryCase, BoundaryCase];
    const src = uses.get(`${card.field}|${t}`)?.source ?? [];
    const first = src[0];
    out.push(
      makeFinding({
        check: CHECK,
        code: "BOUNDARY_SHOWN",
        severity: "info",
        audience: ["clinician", "program_officer"],
        decidedBy: "clinician",
        subjects: [questionSubject(q)],
        params: {
          question: q.label,
          threshold: t,
          unit,
          child: describeChild(model, card.baseline),
          below: withUnit(c1.value),
          at: withUnit(c2.value),
          above: withUnit(c3.value),
          o1: outcomeTitle(model, c1.outcome),
          o2: outcomeTitle(model, c2.outcome),
          o3: outcomeTitle(model, c3.outcome),
          bandsMeet,
          openQuestion: openQ ?? "",
          ...(first === undefined ? {} : { page: [...new Set(src.map((s) => s.page))].sort((x, y) => x - y).join(" and "), quote: first.quote }),
        },
        source: src,
      }),
    );
  }
  return out;
}

/** "1 months" reads wrongly: the plain time units lose their s for exactly 1. */
function singular(unit: string): string {
  return /^ (months|days|years|weeks|hours|minutes)$/.test(unit) ? unit.slice(0, -1) : unit;
}

/** The first open question that concerns one of the calculated values meeting at the cut-off and whose first number is the cut-off (or that names no number). */
function openQuestionFor(model: Model, ids: ReadonlySet<string>, t: number): string | undefined {
  const mine = model.open_questions.filter((o) => o.status === "open" && o.affects.some((x) => ids.has(x)));
  const numbers = (o: { question: string }): string[] => o.question.match(/\d+/g) ?? [];
  const about = mine.filter((o) => numbers(o)[0] === String(t));
  const unnumbered = mine.filter((o) => numbers(o).length === 0);
  return (about.length > 0 ? about : unnumbered).map((o) => o.id).sort()[0];
}
