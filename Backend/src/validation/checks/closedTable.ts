import { OFFICER, BOTH, makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";
import { getAnalysis, notProvenReason } from "../analysis.js";
import { describeChild, exampleOf } from "../child.js";

export const CHECK = "closedTable";

/**
 * Closed table and completeness. The rules must end with one catch-all ("otherwise") rule that is checked last
 * (the schema already insists, this reports it in plain words if a model somehow lacks it), and every
 * combination of answers within the entry limits must get a result.
 * If the combinations cannot all be gone through, nothing is proven: NOT_PROVEN, never a silent pass.
 */
export function closedTable(ctx: CheckContext): Finding[] {
  const model = ctx.model;
  const a = getAnalysis(model, ctx.maxGridPoints);
  const out: Finding[] = [];
  if (!a.closed) {
    const others = model.rules.filter((r) => r.when === "otherwise").length;
    const problem = others === 0 ? "there is no catch-all rule" : others > 1 ? "there is more than one catch-all rule" : "the catch-all rule is not the last one checked";
    out.push(
      makeFinding({
        check: CHECK,
        code: "TABLE_NOT_CLOSED",
        severity: "blocking",
        audience: OFFICER,
        decidedBy: "clinician",
        subjects: [{ kind: "document", id: "rules" }],
        params: { problem },
        source: [],
      }),
    );
    if (a.uncovered.count > 0 && a.uncovered.example !== undefined) {
      out.push(
        makeFinding({
          check: CHECK,
          code: "UNCOVERED_ANSWERS",
          severity: "blocking",
          audience: ["clinician", "program_officer"],
          decidedBy: "clinician",
          subjects: [{ kind: "document", id: "rules" }],
          params: { count: a.uncovered.count, child: describeChild(model, a.uncovered.example) },
          source: [],
          example: exampleOf(a.uncovered.example),
        }),
      );
    }
  }
  const reason = notProvenReason(a);
  if (reason !== undefined) {
    out.push(
      makeFinding({
        check: CHECK,
        code: "NOT_PROVEN",
        severity: "blocking",
        audience: BOTH,
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: "rules" }],
        params: { reason },
        source: [],
      }),
    );
  }
  return out;
}
