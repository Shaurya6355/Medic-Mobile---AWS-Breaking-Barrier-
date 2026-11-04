import { makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";

export const CHECK = "contextNotice";

/**
 * A check that was skipped must never look like a pass. When the booklet reading, the test cases or the form settings were
 * not supplied, one information item says which checks did not run.
 */
export function contextNotice(ctx: CheckContext): Finding[] {
  const checks: string[] = [];
  const needs: string[] = [];
  if (ctx.extraction === undefined) {
    checks.push("the danger-sign check", "the unused-passage check");
    needs.push("the reading of the booklet");
  }
  if (ctx.goldenCases === undefined) {
    checks.push("the test-case check");
    needs.push("the test cases");
  }
  if (ctx.compileSettings === undefined) {
    checks.push("the form-readiness check");
    needs.push("the form settings");
  }
  if (ctx.crossCheck === undefined) {
    checks.push("the comparison with a second, independent draft");
    needs.push("the second draft");
  }
  if (checks.length === 0) return [];
  return [
    makeFinding({
      check: CHECK,
      code: "CONTEXT_NOT_PROVIDED",
      severity: "info",
      audience: ["program_officer", "clinician"],
      decidedBy: "program_officer",
      subjects: [{ kind: "document", id: "context" }],
      params: { checks: checks.join(", "), needs: needs.join(", ") },
      source: [],
    }),
  ];
}
