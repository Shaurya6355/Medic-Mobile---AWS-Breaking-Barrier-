import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeChild, exampleOf } from "../child.js";
import { ruleSubject } from "../describe.js";
import { anyAnalysis, citation, outcomeTitle, simplestPoint } from "./common.js";
import { allMatches, evaluate } from "../../logic/interpreter.js";
import type { Answers } from "../../logic/interpreter.js";
import type { Analysis } from "../analysis.js";
import { outcomeSubject } from "../describe.js";
import { dangerOutcomeIds, scopeRuleIds } from "./dangerSigns.js";

export const CHECK = "severityOrder";

/**
 * Severity order (a safety check). Where the rule that decides (the first to apply) has a LESS urgent result
 * than another rule that also applies, the child is under-triaged. Lower severity number = more urgent.
 * Each (deciding rule, hidden rule) pair is reported once, with an example child, as a blocking
 * SEVERITY_INVERSION. A clinician can approve a pair through ctx.approvedExceptions
 * ({ rules: [decidingRuleId, hiddenRuleId], by, note }); it then becomes an information finding
 * SEVERITY_EXCEPTION_APPROVED that carries who approved it and why.
 * An example found in part of the combinations is real, so this check reports even when NOT_PROVEN.
 *
 * Ranks (red team 1). The results a danger sign leads to are decided from the rules (see dangerSigns.ts), not from
 * the word "refer". Each must have the most urgent rank used in the draft (SEVERITY_DANGER_NOT_TOP), and every other
 * result, except the one for children outside the covered ages, must be strictly less urgent than all of them
 * (SEVERITY_NOT_SEPARATED); results that all share one rank block (SEVERITY_ALL_EQUAL). Without separate ranks the
 * inversion check above cannot see an urgent result hidden by a milder one.
 *
 * Overlaps (red team 1, M81). Where two rules with different results of the most urgent rank both apply to the same
 * child, the ranking cannot say which one is right, so a test case must pin it: a case where the first rule decides
 * and the other also applies. Without one (or without test cases at all) URGENT_OVERLAP_UNTESTED blocks.
 */
export function severityOrder(ctx: CheckContext): Finding[] {
  const out: Finding[] = ranks(ctx);
  const a = anyAnalysis(ctx);
  if (a?.rules === undefined) return out;
  const model = ctx.model;
  // Only over the full set of combinations: a partial set is already NOT_PROVEN, and going through it again costs too much.
  if (a.exact) out.push(...urgentOverlaps(ctx, a));
  for (const inv of a.rules.severityInversions) {
    const first = model.rules.find((r) => r.id === inv.firstRule);
    const hidden = model.rules.find((r) => r.id === inv.overriddenRule);
    if (first === undefined || hidden === undefined) continue;
    const openQ = model.open_questions
      .filter((q) => q.status === "open" && (q.affects.includes(first.id) || q.affects.includes(first.outcome)))
      .map((q) => q.id)
      .sort()[0];
    const example = a.inversionExamples.get(`${inv.firstRule}|${inv.overriddenRule}`) ?? inv.example;
    const c = citation(hidden);
    const approved = ctx.approvedExceptions?.find((x) => x.rules[0] === inv.firstRule && x.rules[1] === inv.overriddenRule);
    const params = {
      firstRule: inv.firstRule,
      overriddenRule: inv.overriddenRule,
      firstOutcome: outcomeTitle(model, inv.firstOutcome),
      overriddenOutcome: outcomeTitle(model, inv.overriddenOutcome),
      child: describeChild(model, example),
      openQuestion: openQ ?? "",
    };
    const subjects = [ruleSubject(first), ruleSubject(hidden)];
    const source = [...citation(first).source, ...c.source];
    out.push(
      approved === undefined
        ? makeFinding({
            check: CHECK,
            code: "SEVERITY_INVERSION",
            severity: "blocking",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects,
            params: { ...params, ...c.params },
            source,
            example: exampleOf(example),
          })
        : makeFinding({
            check: CHECK,
            code: "SEVERITY_EXCEPTION_APPROVED",
            severity: "info",
            audience: ["clinician", "program_officer"],
            decidedBy: "clinician",
            subjects,
            params: { ...params, by: approved.by, note: approved.note },
            source,
            example: exampleOf(example),
          }),
    );
  }
  return out;
}

const BOTH_ROLES = ["clinician", "program_officer"] as ("clinician" | "program_officer")[];

function ranks(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const out: Finding[] = [];
  const common = { check: CHECK, severity: "blocking" as const, audience: BOTH_ROLES, decidedBy: "clinician" as const, source: [] };
  const sevs = model.outcomes.map((o) => o.severity);
  const top = Math.min(...sevs);
  if (model.outcomes.length > 1 && sevs.every((x) => x === top)) {
    out.push(makeFinding({ ...common, code: "SEVERITY_ALL_EQUAL", subjects: [{ kind: "document", id: "model" }], params: { count: model.outcomes.length, severity: top } }));
  }
  const danger = model.outcomes.filter((o) => dangerOutcomeIds(model, ctx.extraction).has(o.id));
  if (danger.length === 0) return out;
  for (const o of danger) {
    if (o.severity === top) continue;
    out.push(makeFinding({ ...common, code: "SEVERITY_DANGER_NOT_TOP", subjects: [outcomeSubject(o)], params: { outcome: o.title, severity: o.severity, top } }));
  }
  const scopeOutcomes = new Set(model.rules.filter((r) => scopeRuleIds(model).has(r.id)).map((r) => r.outcome));
  const worst = danger.reduce((x, y) => (y.severity > x.severity ? y : x));
  const dangerIds = new Set(danger.map((o) => o.id));
  for (const o of model.outcomes) {
    if (dangerIds.has(o.id) || scopeOutcomes.has(o.id) || o.severity > worst.severity) continue;
    out.push(
      makeFinding({
        ...common,
        code: "SEVERITY_NOT_SEPARATED",
        subjects: [outcomeSubject(o), outcomeSubject(worst)],
        params: { milder: o.title, milderSeverity: o.severity, outcome: worst.title, severity: worst.severity },
      }),
    );
  }
  return out;
}

function urgentOverlaps(ctx: CheckContext, a: Analysis): Finding[] {
  const model = ctx.model;
  const sev = new Map(model.outcomes.map((o) => [o.id, o.severity]));
  const top = Math.min(...model.outcomes.map((o) => o.severity));
  const ruleOutcome = new Map(model.rules.map((r) => [r.id, r.outcome]));
  const pairs = new Map<string, Answers[]>();
  for (const p of a.points) {
    const e = evaluate(model, p, { allowMissing: true });
    if (e.severity !== top) continue;
    for (const id of allMatches(model, p, { allowMissing: true })) {
      const o = ruleOutcome.get(id) as string;
      if (id === e.rule || o === e.outcome || sev.get(o) !== top) continue;
      const key = `${e.rule}|${id}`;
      const l = pairs.get(key) ?? [];
      l.push(p);
      pairs.set(key, l);
    }
  }
  const covered = (first: string, other: string): boolean =>
    (ctx.goldenCases ?? []).some((c) => {
      try {
        const answers = c.answers as Answers;
        return evaluate(model, answers, { allowMissing: true }).rule === first && allMatches(model, answers, { allowMissing: true }).includes(other);
      } catch {
        return false;
      }
    });
  const out: Finding[] = [];
  for (const [key, points] of [...pairs].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const [first, other] = key.split("|") as [string, string];
    if (covered(first, other)) continue;
    const r1 = model.rules.find((r) => r.id === first)!;
    const r2 = model.rules.find((r) => r.id === other)!;
    const example = simplestPoint(points, () => true) as Answers;
    out.push(
      makeFinding({
        check: CHECK,
        code: "URGENT_OVERLAP_UNTESTED",
        severity: "blocking",
        audience: BOTH_ROLES,
        decidedBy: "clinician",
        subjects: [ruleSubject(r1), ruleSubject(r2)],
        params: {
          firstRule: first,
          overriddenRule: other,
          firstOutcome: outcomeTitle(model, r1.outcome),
          overriddenOutcome: outcomeTitle(model, r2.outcome),
          child: describeChild(model, example),
        },
        source: [],
        example: exampleOf(example),
      }),
    );
  }
  return out;
}
