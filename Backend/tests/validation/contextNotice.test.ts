import { describe, expect, it } from "vitest";
import { contextNotice } from "../../src/validation/checks/contextNotice.js";
import { demoSettings, goldenCases, matchedCtx, realExtraction, v1Copy } from "./helpers.js";

describe("contextNotice", () => {
  it("says once which checks did not run when nothing optional was supplied", () => {
    const fs = contextNotice(matchedCtx());
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("CONTEXT_NOT_PROVIDED");
    expect(f.severity).toBe("info");
    expect(f.audience).toEqual(["program_officer", "clinician"]);
    expect(f.decidedBy).toBe("program_officer");
    expect(f.message).toContain("danger-sign check");
    expect(f.message).toContain("unused-passage check");
    expect(f.message).toContain("test-case check");
    expect(f.message).toContain("form-readiness check");
    expect(f.message).toContain("comparison with a second, independent draft");
    expect(f.message).toContain("not a pass");
  });
  it("names only what is missing", () => {
    const fs = contextNotice({ ...matchedCtx(), extraction: realExtraction(), goldenCases: goldenCases() });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.message).toContain("form-readiness check");
    expect(fs[0]!.message).not.toContain("danger-sign");
    expect(fs[0]!.message).not.toContain("test-case");
  });
  it("is silent when everything was supplied", () => {
    expect(contextNotice({ ...matchedCtx(), extraction: realExtraction(), goldenCases: goldenCases(), compileSettings: demoSettings(), crossCheck: { model: v1Copy() } })).toEqual([]);
  });
  it("an empty list of test cases still counts as supplied", () => {
    expect(contextNotice({ ...matchedCtx(), extraction: realExtraction(), goldenCases: [], compileSettings: demoSettings(), crossCheck: { model: v1Copy() } })).toEqual([]);
  });
  it("names the second draft when it is the only thing missing, so a skipped comparison never looks like a pass", () => {
    const fs = contextNotice({ ...matchedCtx(), extraction: realExtraction(), goldenCases: goldenCases(), compileSettings: demoSettings() });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.params["needs"]).toBe("the second draft");
    expect(fs[0]!.message).toContain("comparison with a second, independent draft");
  });
});
