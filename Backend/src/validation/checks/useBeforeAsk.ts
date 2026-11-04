import type { Answers } from "../../logic/interpreter.js";
import type { Condition, Model } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import { describeChild, describeCondition, exampleOf } from "../child.js";
import { describeDerived, describeRule, derivedSubject, ruleSubject } from "../describe.js";
import { anyAnalysis, citation, simplestPoint } from "./common.js";

export const CHECK = "useBeforeAsk";

type Atom = Extract<Condition, { field: string }>;

/**
 * USE BEFORE ASK.
 *
 * A question with a condition for being asked (shown_when W) may be unanswered, and an unanswered question
 * makes every test on it false. A rule or calculated value that reads such a question is only safe when
 * the place where it reads it already guarantees W.
 *
 * Precise rule. Walk the condition tree of each rule and calculated value. Every test (atom) on a
 * question f with condition W must sit under a chain of "all" ancestors whose OTHER branches, taken
 * together, imply W. The facts known on the path to an atom are collected like this:
 *   - going down through an "all", the facts of all its other children are added (siblings, at any depth
 *     of nested "all"); going down through an "any" adds nothing (an alternative guarantees nothing);
 *   - the facts of a branch: a test is a fact; an "all" has the facts of all its children; an "any" has none;
 *   - a fact about a question also brings the question's own condition (a true test means the question was
 *     answered, so it was asked); a fact "calculated value D is yes" brings the facts of D's definition
 *     (this is how a calculated value can encode the guard); both are followed without loops.
 * W is implied by the facts when: W is a test and some fact is the same test or a stronger one (at least a
 * higher number, or less than a lower number, on the same question); W is an "all" and each part is
 * implied; W is an "any" and some part is implied.
 * An unguarded test is reported only with a witness: a combination of answers where the question is not
 * asked, and an answer to it that would make the test true although, unanswered, it is false. A test that
 * no answer within the entry limits can make true cannot differ, so it is not reported.
 */
export function useBeforeAsk(ctx: CheckContext): Finding[] {
  const a = anyAnalysis(ctx);
  if (a === undefined) return [];
  const model = ctx.model;
  const questions = new Map(model.questions.map((q) => [q.id, q]));
  const derived = new Map(model.derived.map((d) => [d.id, d]));
  const out: Finding[] = [];

  const factsOf = (c: Condition, seen: Set<string>): Atom[] => {
    if ("field" in c) {
      const res: Atom[] = [c];
      const q = questions.get(c.field);
      if (q?.shown_when !== undefined) res.push(...factsOf(q.shown_when, seen));
      if (c.op === "is_yes" && derived.has(c.field) && !seen.has(c.field)) {
        seen.add(c.field);
        res.push(...factsOf((derived.get(c.field) as Model["derived"][number]).definition, seen));
      }
      return res;
    }
    if ("all" in c) return c.all.flatMap((k) => factsOf(k, seen));
    return [];
  };

  const atomImplied = (w: Atom, f: Atom): boolean => {
    if (w.field !== f.field) return false;
    if (w.op === "is_yes") return f.op === "is_yes";
    if (f.op === "is_yes" || f.op !== w.op) return false;
    return w.op === "at_least" ? f.value >= w.value : f.value <= w.value;
  };

  const implied = (w: Condition, facts: readonly Atom[]): boolean => {
    if ("field" in w) return facts.some((f) => atomImplied(w, f));
    if ("all" in w) return w.all.every((k) => implied(k, facts));
    return w.any.some((k) => implied(k, facts));
  };

  const unguarded = (root: Condition): Atom[] => {
    const found: Atom[] = [];
    const walk = (c: Condition, facts: readonly Atom[]): void => {
      if ("field" in c) {
        const q = questions.get(c.field);
        if (q?.shown_when !== undefined && !implied(q.shown_when, facts)) found.push(c);
        return;
      }
      if ("any" in c) {
        for (const k of c.any) walk(k, facts);
        return;
      }
      c.all.forEach((k, i) => {
        const sibling: Atom[] = [];
        c.all.forEach((o, j) => {
          if (j !== i) sibling.push(...factsOf(o, new Set()));
        });
        walk(k, [...facts, ...sibling]);
      });
    };
    walk(root, []);
    return found;
  };

  const answerThatMakesTrue = (atom: Atom): number | boolean | undefined => {
    if (atom.op === "is_yes") return true;
    const q = questions.get(atom.field);
    const lo = q?.constraint?.min ?? -Infinity;
    const hi = q?.constraint?.max ?? Infinity;
    const b = Math.ceil(atom.value);
    const v = atom.op === "at_least" ? Math.max(b, lo) : Math.min(b - 1, hi);
    return v >= lo && v <= hi ? v : undefined;
  };

  const examine = (root: Condition, subject: Subject, item: string, src: Parameters<typeof citation>[0]): void => {
    const reported = new Set<string>();
    for (const atom of unguarded(root)) {
      if (reported.has(atom.field)) continue;
      const q = questions.get(atom.field);
      if (q === undefined || q.shown_when === undefined) continue;
      const answer = answerThatMakesTrue(atom);
      if (answer === undefined) continue;
      const witness: Answers | undefined = simplestPoint(a.points, (p) => p[atom.field] === undefined);
      if (witness === undefined) continue;
      reported.add(atom.field);
      const c = citation(src);
      const unit = q.unit === undefined ? "" : ` ${q.unit.replace(/_/g, " ")}`;
      out.push(
        makeFinding({
          check: CHECK,
          code: "USE_BEFORE_ASK",
          severity: "blocking",
          audience: ["program_officer", "clinician"],
          decidedBy: "program_officer",
          subjects: [subject, { kind: "question", id: q.id }],
          params: {
            item,
            question: q.label,
            guard: describeCondition(model, q.shown_when),
            child: describeChild(model, witness),
            answer: typeof answer === "boolean" ? "yes" : `${answer}${unit}`,
            ...c.params,
          },
          source: c.source,
          example: exampleOf(witness),
        }),
      );
    }
  };

  for (const d of model.derived) examine(d.definition, derivedSubject(d), describeDerived(d), d);
  for (const r of model.rules) if (r.when !== "otherwise") examine(r.when, ruleSubject(r), describeRule(model, r), r);
  return out;
}
