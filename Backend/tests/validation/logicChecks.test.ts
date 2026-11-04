import { describe, expect, it } from "vitest";
import { DEFAULT_CHECKS, runChecks } from "../../src/validation/runChecks.js";
import { getAnalysis } from "../../src/validation/analysis.js";
import { goldenCases, matchedCtx, realCtx, v1Copy } from "./helpers.js";

const REST = ["fieldNames", "followUpConsistency", "clinicalText", "openQuestions", "dangerSignCoverage", "sourceCoverage", "goldenCases", "compileReady", "crossCheck", "contextNotice"];
const LOGIC = ["closedTable", "exclusivity", "reachability", "deadInputs", "useBeforeAsk", "severityOrder", "requiredQuestions", "ageGroups", "boundaryCards"];

describe("logic checks together on v1", () => {
  it("registers the logic checks after the grounding checks, in order", () => {
    const all = ["schemaReferences", "guidelineFile", "quoteGrounding", "numberGrounding", "inclusivityWording", ...LOGIC, ...REST];
    expect(DEFAULT_CHECKS.map((c) => c.name)).toEqual(all);
    expect(runChecks(matchedCtx()).ranChecks).toEqual(all);
  });
  it("yields exactly the justified findings and no false positives", () => {
    const r = runChecks(matchedCtx());
    const logic = r.findings.filter((f) => LOGIC.includes(f.check));
    const summary = logic.map((f) => `${f.severity}:${f.code}:${f.params["firstRule"] ?? f.params["threshold"] ?? f.params["questions"] ?? ""}`).sort();
    expect(summary).toEqual(
      [
        // No severity inversion any more: R1 (outside the ages AND a danger sign) is checked before the plain danger-sign rules.
        // R1, R3 and R4 are equally urgent and overlap in pairs; no test cases are supplied here to pin which one wins (red team 1, M81)
        "blocking:URGENT_OVERLAP_UNTESTED:R1",
        "blocking:URGENT_OVERLAP_UNTESTED:R1",
        "blocking:URGENT_OVERLAP_UNTESTED:R3",
        "info:BOUNDARY_SHOWN:2",
        "info:BOUNDARY_SHOWN:12",
        "info:BOUNDARY_SHOWN:60",
        "info:BOUNDARY_SHOWN:14",
        "info:BOUNDARY_SHOWN:40",
        "info:BOUNDARY_SHOWN:50",
        "info:UNMEASURABLE_NOT_SUPPORTED:For how many days has the child had the cough?; Count the child's breaths in 1 minute",
      ].sort(),
    );
    expect(r.status).toBe("fail");
  });
  it("on the real pair (with the proposed test cases) the only blocking finding of the file and logic checks is the file mismatch: the old severity inversions are gone", () => {
    const r = runChecks({ ...realCtx(), goldenCases: goldenCases() });
    expect(r.findings.filter((f) => f.severity === "blocking" && (f.check === "guidelineFile" || LOGIC.includes(f.check))).map((f) => f.code).sort()).toEqual(["GUIDELINE_FILE_MISMATCH"]);
  });
  it("claims PROVEN in plain words without claiming clinical correctness", () => {
    const r = runChecks(matchedCtx());
    expect(r.claim).toBe("PROVEN");
    expect(r.claimText).toMatch(/^Checked for every combination of answers within the entry limits/);
    expect(r.claimText).toMatch(/not .*clinic/i);
  });
  it("claims NOT_PROVEN, with the reason, when the combinations cannot all be checked or a check did not run", () => {
    const big = runChecks({ ...matchedCtx(), maxGridPoints: 50 });
    expect(big.claim).toBe("NOT_PROVEN");
    expect(big.claimText).toMatch(/^Not proven: /);
    expect(big.findings.some((f) => f.code === "NOT_PROVEN")).toBe(true);
    const none = runChecks(matchedCtx(), { checks: [] });
    expect(none.claim).toBe("NOT_PROVEN");
    expect(none.claimText).toMatch(/^Not proven: /);
    const bad = runChecks(matchedCtx((m) => { delete m.questions; }));
    expect(bad.claim).toBe("NOT_PROVEN");
  });
  it("is deterministic: the same input gives the same findings, ids and order", () => {
    const a = runChecks(matchedCtx((m) => { m.derived.find((d: any) => d.id === "fast_breathing").definition = m.derived.find((d: any) => d.id === "fast_breathing").definition.all[1]; }));
    const b = runChecks(matchedCtx((m) => { m.derived.find((d: any) => d.id === "fast_breathing").definition = m.derived.find((d: any) => d.id === "fast_breathing").definition.all[1]; }));
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
    expect(a.findings.map((f) => f.message)).toEqual(b.findings.map((f) => f.message));
    expect(a.findings.some((f) => f.code === "USE_BEFORE_ASK")).toBe(true);
  });
  it("computes the analysis once per model and shares it between the checks", () => {
    const m = v1Copy();
    const first = getAnalysis(m);
    runChecks({ model: m });
    expect(getAnalysis(m)).toBe(first);
  });
  it("runs the whole suite on v1 in a few seconds", () => {
    const t = Date.now();
    runChecks(matchedCtx());
    expect(Date.now() - t).toBeLessThan(4000);
  });
});
