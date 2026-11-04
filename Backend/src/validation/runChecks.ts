import { makeFinding, BOTH } from "./finding.js";
import type { CheckContext, Finding } from "./finding.js";
import { clip } from "./text.js";
import { schemaReferences } from "./checks/schemaReferences.js";
import { guidelineFile } from "./checks/guidelineFile.js";
import { quoteGrounding } from "./checks/quoteGrounding.js";
import { numberGrounding } from "./checks/numberGrounding.js";
import { closedTable } from "./checks/closedTable.js";
import { exclusivity } from "./checks/exclusivity.js";
import { reachability } from "./checks/reachability.js";
import { deadInputs } from "./checks/deadInputs.js";
import { useBeforeAsk } from "./checks/useBeforeAsk.js";
import { severityOrder } from "./checks/severityOrder.js";
import { requiredQuestions } from "./checks/requiredQuestions.js";
import { ageGroups } from "./checks/ageGroups.js";
import { boundaryCardsCheck } from "./checks/boundaryCards.js";
import { inclusivityWording } from "./checks/inclusivityWording.js";
import { fieldNames } from "./checks/fieldNames.js";
import { followUpConsistency } from "./checks/followUpConsistency.js";
import { clinicalText } from "./checks/clinicalText.js";
import { openQuestions } from "./checks/openQuestions.js";
import { dangerSignCoverage } from "./checks/dangerSignCoverage.js";
import { sourceCoverage } from "./checks/sourceCoverage.js";
import { goldenCasesCheck } from "./checks/goldenCases.js";
import { compileReady } from "./checks/compileReady.js";
import { contextNotice } from "./checks/contextNotice.js";
import { crossCheck } from "./checks/crossCheck.js";
import { gates } from "./gates.js";
import type { Gates } from "./gates.js";
import { getAnalysis } from "./analysis.js";

export type CheckFn = (ctx: CheckContext) => Finding[];
export type NamedCheck = {
  name: string;
  run: CheckFn;
  /** Skipped when the model did not parse (default false). */
  needsValidModel?: boolean;
};

export const DEFAULT_CHECKS: readonly NamedCheck[] = [
  { name: "schemaReferences", run: schemaReferences },
  { name: "guidelineFile", run: guidelineFile, needsValidModel: true },
  { name: "quoteGrounding", run: quoteGrounding, needsValidModel: true },
  { name: "numberGrounding", run: numberGrounding, needsValidModel: true },
  { name: "inclusivityWording", run: inclusivityWording, needsValidModel: true },
  // Logic analysis over the exact answer grid. The first of them to run computes the analysis; the others reuse it (see analysis.ts).
  { name: "closedTable", run: closedTable, needsValidModel: true },
  { name: "exclusivity", run: exclusivity, needsValidModel: true },
  { name: "reachability", run: reachability, needsValidModel: true },
  { name: "deadInputs", run: deadInputs, needsValidModel: true },
  { name: "useBeforeAsk", run: useBeforeAsk, needsValidModel: true },
  { name: "severityOrder", run: severityOrder, needsValidModel: true },
  { name: "requiredQuestions", run: requiredQuestions, needsValidModel: true },
  { name: "ageGroups", run: ageGroups, needsValidModel: true },
  { name: "boundaryCards", run: boundaryCardsCheck, needsValidModel: true },
  // Structure, wording and approval gates.
  { name: "fieldNames", run: fieldNames, needsValidModel: true },
  { name: "followUpConsistency", run: followUpConsistency, needsValidModel: true },
  { name: "clinicalText", run: clinicalText, needsValidModel: true },
  { name: "openQuestions", run: openQuestions, needsValidModel: true },
  // Need the optional context (extraction, test cases, form settings); silent without it, and contextNotice says so.
  { name: "dangerSignCoverage", run: dangerSignCoverage, needsValidModel: true },
  { name: "sourceCoverage", run: sourceCoverage, needsValidModel: true },
  { name: "goldenCases", run: goldenCasesCheck, needsValidModel: true },
  { name: "compileReady", run: compileReady, needsValidModel: true },
  { name: "crossCheck", run: crossCheck, needsValidModel: true },
  { name: "contextNotice", run: contextNotice, needsValidModel: true },
];

/** Checks whose crash means the claim of having gone through every combination of answers does not hold. */
const LOGIC_CHECKS = new Set(["closedTable", "exclusivity", "reachability", "deadInputs", "useBeforeAsk", "severityOrder"]);

export type RunChecksOptions = { checks?: readonly NamedCheck[] };
export type RunChecksResult = {
  findings: Finding[];
  blocking: number;
  status: "pass" | "fail";
  ranChecks: string[];
  /** PROVEN: every combination of answers within the entry limits was gone through. Never a claim of clinical correctness. */
  claim: "PROVEN" | "NOT_PROVEN";
  claimText: string;
  /** Who may sign and build next, and what stands in the way. */
  gates: Gates;
};

const SEVERITY_RANK = { blocking: 0, warning: 1, info: 2 } as const;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Runs every check in registry order. A check that throws becomes a blocking CHECK_CRASHED finding,
 * never a silent pass. Findings are de-duplicated by id and sorted by severity, check, id.
 */
export function runChecks(ctx: CheckContext, opts: RunChecksOptions = {}): RunChecksResult {
  const checks = opts.checks ?? DEFAULT_CHECKS;
  const byId = new Map<string, Finding>();
  const ranChecks: string[] = [];
  let modelInvalid = false;
  for (const c of checks) {
    if (c.needsValidModel === true && modelInvalid) continue;
    ranChecks.push(c.name);
    let out: Finding[];
    try {
      out = c.run(ctx);
    } catch (e) {
      out = [
        makeFinding({
          check: c.name,
          code: "CHECK_CRASHED",
          severity: "blocking",
          audience: BOTH,
          decidedBy: "program_officer",
          subjects: [{ kind: "document", id: "model" }],
          params: { check: c.name, error: clip(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error", 200) },
          source: [],
        }),
      ];
    }
    for (const f of out) {
      if (f.code === "SCHEMA_INVALID") modelInvalid = true;
      if (!byId.has(f.id)) byId.set(f.id, f);
    }
  }
  const findings = [...byId.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.check, b.check) || cmp(a.id, b.id),
  );
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const { claim, claimText } = makeClaim(ctx, findings, ranChecks, modelInvalid);
  return { findings, blocking, status: blocking === 0 ? "pass" : "fail", ranChecks, claim, claimText, gates: gates({ findings, claim, claimText }, ctx) };
}

function makeClaim(ctx: CheckContext, findings: readonly Finding[], ranChecks: readonly string[], modelInvalid: boolean): { claim: "PROVEN" | "NOT_PROVEN"; claimText: string } {
  const notProven = (reason: string) => ({
    claim: "NOT_PROVEN" as const,
    claimText: `Not proven: ${reason}. The results of the other checks only hold for what was looked at. Nothing here says the guideline has been translated correctly; that is for the clinician to decide.`,
  });
  if (modelInvalid) return notProven("the draft is not in the expected form, so it could not be worked through");
  if (!ranChecks.includes("closedTable")) return notProven("the checks of the answer combinations were not run");
  const crashed = findings.find((f) => f.code === "CHECK_CRASHED" && LOGIC_CHECKS.has(f.check));
  if (crashed !== undefined) return notProven(`one of the checks of the answer combinations (${crashed.check}) stopped before it finished`);
  const np = findings.find((f) => f.code === "NOT_PROVEN");
  if (np !== undefined) return notProven(String(np.params["reason"]));
  const points = getAnalysis(ctx.model, ctx.maxGridPoints).points.length;
  return {
    claim: "PROVEN",
    claimText: `Checked for every combination of answers within the entry limits (${points} combinations, covering both sides of every cut-off the rules use): every child gets a result, and the checks looked for rules that never decide, results and questions that can never come up, and urgent results hidden by less urgent ones. The findings list what was found. This does not show that the guideline has been translated correctly: whether the results are clinically right is for the clinician to decide.`,
  };
}
