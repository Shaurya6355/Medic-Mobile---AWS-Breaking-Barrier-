import { describe, expect, it } from "vitest";
import { makeFinding } from "../../src/validation/finding.js";
import { DEFAULT_CHECKS, runChecks } from "../../src/validation/runChecks.js";
import { goldenCases, matchedCtx, realCtx } from "./helpers.js";

const f = (tag: string, severity: "blocking" | "warning" | "info", check: string, id: string) =>
  makeFinding({
    check,
    code: "DUPLICATE_ID",
    severity,
    audience: ["program_officer"],
    decidedBy: "program_officer",
    subjects: [{ kind: "rule", id }],
    params: { id, kinds: tag },
    source: [],
  });

describe("runChecks", () => {
  it("v1 against the real booklet with a matching file blocks on the open questions and the numbers its quotes do not carry (no severity inversion any more)", () => {
    // with the proposed test cases, which pin the overlap of the two equally urgent referrals (red team 1, URGENT_OVERLAP_UNTESTED)
    const r = runChecks({ ...matchedCtx(), goldenCases: goldenCases() });
    expect(r.status).toBe("fail");
    const codes = r.findings.filter((x) => x.severity === "blocking").map((x) => x.code);
    expect(codes).not.toContain("SEVERITY_INVERSION");
    expect(codes).not.toContain("AGE_GAP");
    expect(codes.filter((c) => c === "UNGROUNDED_NUMBER")).toHaveLength(17);
    expect(codes.filter((c) => c === "NUMBER_IN_TEXT_UNSUPPORTED")).toHaveLength(3);
    expect(codes.filter((c) => c === "OPEN_QUESTION")).toHaveLength(6);
    // red team 2: NUMBER_IN_TEXT_UNSUPPORTED for the "250 mg" in v1's antibiotic action texts, which their quotes do not carry
    expect(new Set(codes)).toEqual(new Set(["OPEN_QUESTION", "UNGROUNDED_NUMBER", "NUMBER_IN_TEXT_UNSUPPORTED"]));
    expect(r.ranChecks.slice(0, 5)).toEqual(["schemaReferences", "guidelineFile", "quoteGrounding", "numberGrounding", "inclusivityWording"]);
  });
  it("with the file and quote checks alone, v1 against the real booklet passes", () => {
    const r = runChecks(matchedCtx(), { checks: DEFAULT_CHECKS.slice(0, 3) });
    expect(r.status).toBe("pass");
    expect(r.ranChecks).toEqual(["schemaReferences", "guidelineFile", "quoteGrounding"]);
  });
  it("fails the real pair with the file mismatch on top of the rest", () => {
    const r = runChecks(realCtx());
    expect(r.status).toBe("fail");
    expect(r.findings.filter((x) => x.code === "GUIDELINE_FILE_MISMATCH")).toHaveLength(1);
    expect(r.blocking).toBe(r.findings.filter((x) => x.severity === "blocking").length);
  });
  it("returns the gates with the result", () => {
    const r = runChecks(realCtx());
    expect(r.gates.canOfficerSign).toBe(false);
    expect(r.gates.canCompile).toBe(false);
    expect(r.gates.blockers.compile).toHaveLength(r.blocking);
    expect(r.gates.summary).toMatch(/program officer cannot sign yet/i);
  });
  it("says once which optional checks were skipped, so a skipped check never looks like a pass", () => {
    const r = runChecks(matchedCtx());
    const n = r.findings.filter((x) => x.code === "CONTEXT_NOT_PROVIDED");
    expect(n).toHaveLength(1);
    expect(n[0]!.severity).toBe("info");
    expect(r.findings.some((x) => ["DANGER_SIGN_NOT_MODELLED", "UNCITED_PASSAGE", "GOLDEN_COUNT", "COMPILE_NOT_READY"].includes(x.code))).toBe(false);
  });
  it("converts a throwing check into a blocking CHECK_CRASHED finding", () => {
    const r = runChecks(matchedCtx(), {
      checks: [
        { name: "boom", run: () => { throw new Error("kaput"); } },
        { name: "fine", run: () => [] },
      ],
    });
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(1);
    expect(r.findings[0]?.code).toBe("CHECK_CRASHED");
    expect(r.findings[0]?.check).toBe("boom");
    expect(r.ranChecks).toEqual(["boom", "fine"]);
  });
  it("sorts by severity, check, id and removes duplicates", () => {
    const a = f("X_A", "info", "b", "r1");
    const b = f("X_B", "blocking", "z", "r2");
    const c = f("X_C", "blocking", "a", "r3");
    const d = f("X_D", "warning", "a", "r4");
    const r = runChecks(matchedCtx(), { checks: [{ name: "one", run: () => [a, b, c, d, c] }] });
    expect(r.findings.map((x) => x.params["kinds"])).toEqual(["X_C", "X_B", "X_D", "X_A"]);
  });
  it("gives identical ids and order for the same input twice", () => {
    const run = () => runChecks(realCtx((m) => { m.rules[2].source[0].quote = "invented words"; m.outcomes[4].follow_up.due_in_days = 9; }));
    const a = run();
    const b = run();
    expect(a.findings.length).toBeGreaterThan(1);
    expect(a.findings.map((x) => x.id)).toEqual(b.findings.map((x) => x.id));
  });
  it("skips the content checks when the model does not parse", () => {
    const r = runChecks(matchedCtx((m) => { delete m.questions; }));
    expect(r.status).toBe("fail");
    expect(r.findings.every((x) => x.check === "schemaReferences")).toBe(true);
    expect(r.ranChecks).toEqual(["schemaReferences"]);
  });
});
