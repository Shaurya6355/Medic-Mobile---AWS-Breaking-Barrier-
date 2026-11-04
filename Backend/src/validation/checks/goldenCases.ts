import { AnswerError, MissingRequiredError, evaluate } from "../../logic/interpreter.js";
import type { Model } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { describeOutcome, outcomeSubject } from "../describe.js";
import { clip } from "../text.js";

export const CHECK = "goldenCases";
const PENDING = /pending|awaiting|not (?:yet )?(?:clinically )?confirmed/i;

/** Plain-language reason why the answers of a test case cannot be used. */
function problemOf(model: Model, e: unknown): string {
  const label = (id: string): string => `"${clip(model.questions.find((q) => q.id === id)?.label ?? id, 60)}"`;
  if (e instanceof MissingRequiredError) return `no answer was given for the required ${e.ids.length === 1 ? "question" : "questions"} ${e.ids.map(label).join(", ")}`;
  if (e instanceof AnswerError) {
    return e.issues
      .map((i) => {
        let m = i.match(/^([a-z0-9_]+): unknown question$/);
        if (m) return `"${m[1]}" is not one of the questions of the draft`;
        m = i.match(/^([a-z0-9_]+): expected yes\/no/);
        if (m) return `the answer to ${label(m[1] as string)} must be yes or no`;
        m = i.match(/^([a-z0-9_]+): expected an integer/);
        if (m) return `the answer to ${label(m[1] as string)} must be a whole number`;
        m = i.match(/^([a-z0-9_]+): (-?[\d.]+) outside (-?[\d.]+)\.\.(-?[\d.]+)/);
        if (m) return `the answer ${m[2]} to ${label(m[1] as string)} is outside the allowed entries (${m[3]} to ${m[4]})`;
        return "an answer cannot be used";
      })
      .join("; ");
  }
  return "the draft could not be worked through for this case";
}

/**
 * Runs each golden case through the interpreter. A case that gets another result (or the right one through another rule)
 * blocks; one whose answers cannot be used blocks; cases still waiting for the clinician are listed once; every result
 * should have a case. Needs ctx.goldenCases; reports nothing without it. Cases are written by people, never by the AI.
 */
export function goldenCasesCheck(ctx: CheckContext): Finding[] {
  const cases = ctx.goldenCases;
  if (cases === undefined) return [];
  const { model } = ctx;
  const title = (id: string): string => model.outcomes.find((o) => o.id === id)?.title ?? id;
  const out: Finding[] = [];
  let agree = 0;
  const covered = new Set<string>();
  const pending: string[] = [];

  for (const c of cases) {
    const subject = { kind: "document" as const, id: `golden:${c.id}` };
    const common = { check: CHECK, audience: ["clinician", "program_officer"] as ("clinician" | "program_officer")[], decidedBy: "clinician" as const, subjects: [subject], source: [] };
    if (PENDING.test(c.note ?? "")) pending.push(c.id);
    if (!model.outcomes.some((o) => o.id === c.expected_outcome)) {
      out.push(makeFinding({ ...common, code: "GOLDEN_INVALID", severity: "blocking", params: { id: c.id, description: clip(c.description, 120), problem: `it expects a result ("${c.expected_outcome}") that the draft does not have` } }));
      continue;
    }
    covered.add(c.expected_outcome);
    let ev;
    try {
      ev = evaluate(model, c.answers);
    } catch (e) {
      out.push(makeFinding({ ...common, code: "GOLDEN_INVALID", severity: "blocking", params: { id: c.id, description: clip(c.description, 120), problem: problemOf(model, e) } }));
      continue;
    }
    const sameOutcome = ev.outcome === c.expected_outcome;
    const sameRule = c.expected_rule === undefined || ev.rule === c.expected_rule;
    if (sameOutcome && sameRule) {
      agree++;
      continue;
    }
    out.push(
      makeFinding({
        ...common,
        code: "GOLDEN_MISMATCH",
        severity: "blocking",
        params: {
          id: c.id,
          description: clip(c.description, 120),
          expected: title(c.expected_outcome),
          actual: title(ev.outcome),
          rule: ev.rule,
          expectedRule: c.expected_rule ?? "",
          ruleOnly: sameOutcome,
          note: clip(c.note ?? "", 160),
        },
      }),
    );
  }

  if (pending.length > 0) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "GOLDEN_PENDING_CLINICIAN",
        severity: "info",
        audience: ["clinician"],
        decidedBy: "clinician",
        subjects: pending.map((id) => ({ kind: "document" as const, id: `golden:${id}` })),
        params: { count: pending.length, ids: pending.join(", ") },
        source: [],
      }),
    );
  }
  for (const o of model.outcomes) {
    if (covered.has(o.id)) continue;
    out.push(
      makeFinding({ check: CHECK, code: "OUTCOME_WITHOUT_GOLDEN_CASE", severity: "warning", audience: ["clinician", "program_officer"], decidedBy: "clinician", subjects: [outcomeSubject(o)], params: { item: describeOutcome(o) }, source: [] }),
    );
  }
  out.push(
    makeFinding({
      check: CHECK,
      code: "GOLDEN_COUNT",
      severity: "info",
      audience: ["clinician", "program_officer"],
      decidedBy: "clinician",
      subjects: [{ kind: "document", id: "golden" }],
      params: { total: cases.length, agree, different: cases.length - agree },
      source: [],
    }),
  );
  return out;
}
