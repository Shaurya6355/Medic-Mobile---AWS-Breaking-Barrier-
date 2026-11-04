import { describe, expect, it } from "vitest";
import { ageGroups } from "../../src/validation/checks/ageGroups.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

const band = (m: any) => m.derived.find((d: any) => d.id === "fast_breathing").definition.all[1].any;

describe("ageGroups", () => {
  it("passes v1: 2 up to 12 and 12 up to 60 split the covered ages exactly, and so do both dose lists", () => {
    expect(ageGroups(matchedCtx())).toEqual([]);
  });
  it("reports a gap between the age bands", () => {
    const fs = ageGroups(matchedCtx((m) => { band(m)[0].all[1].value = 11; }));
    expect(codesOf(fs)).toContain("AGE_GAP");
    const gap = fs.find((f) => f.code === "AGE_GAP")!;
    expect(gap.severity).toBe("blocking");
    expect(gap.message).toMatch(/11 up to 12 months/);
    expect(gap.message).not.toMatch(JARGON_RE);
  });
  it("reports an overlap between the age bands", () => {
    const fs = ageGroups(matchedCtx((m) => { band(m)[1].all[0].value = 10; }));
    expect(codesOf(fs)).toContain("AGE_OVERLAP");
    expect(fs.find((f) => f.code === "AGE_OVERLAP")!.message).toMatch(/10 and 12 months|10 up to 12 months/);
  });
  it("reports bands that stop short of the end of the covered ages", () => {
    const fs = ageGroups(matchedCtx((m) => { band(m)[1].all[1].value = 48; }));
    expect(codesOf(fs)).toContain("AGE_GAP");
  });
  it("reports a dose list that does not match the fast-breathing bands, naming the action", () => {
    const fs = ageGroups(
      matchedCtx((m) => {
        const a = m.outcomes.find((o: any) => o.id === "refer_urgent_with_antibiotic").actions.find((x: any) => x.dose_by_age);
        a.dose_by_age[0].age_months_below = 13;
        a.dose_by_age[1].age_months_min = 13;
      }),
    );
    expect(codesOf(fs)).toEqual(["DOSE_BANDS_MISMATCH"]);
    expect(fs[0]!.message).toMatch(/13/);
    expect(fs[0]!.source.length).toBeGreaterThan(0);
  });
  it("reports a gap and an overlap inside a dose list", () => {
    const gap = ageGroups(matchedCtx((m) => {
      const a = m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions.find((x: any) => x.dose_by_age);
      a.dose_by_age[1].age_months_min = 14;
    }));
    expect(codesOf(gap)).toContain("AGE_GAP");
    const over = ageGroups(matchedCtx((m) => {
      const a = m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions.find((x: any) => x.dose_by_age);
      a.dose_by_age[1].age_months_min = 10;
    }));
    expect(codesOf(over)).toContain("AGE_OVERLAP");
  });
});

describe("ageGroups: the age question, entry limits and dose tables (red team 1)", () => {
  it("blocks when no age question in months is found instead of switching the age checks off (M86, M87)", () => {
    const fs = ageGroups(matchedCtx((m) => { m.questions[0].unit = "mo"; }));
    expect(codesOf(fs)).toEqual(["AGE_QUESTION_MISSING"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.message).toContain('"months"');
    expect(fs[0]!.message).not.toMatch(JARGON_RE);
  });
  it("still checks the dose tables when the age question cannot be found (M86)", () => {
    const fs = ageGroups(matchedCtx((m) => {
      m.questions[0].unit = "mo";
      m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions[0].dose_by_age[0].age_months_below = 60;
    }));
    expect(codesOf(fs)).toContain("AGE_OVERLAP");
  });
  it("blocks entry limits on the age that leave out covered ages (M51)", () => {
    const fs = ageGroups(matchedCtx((m) => { m.questions[0].constraint.max = 11; }));
    const f = fs.find((x) => x.code === "AGE_LIMITS_EXCLUDE_SCOPE")!;
    expect(f.severity).toBe("blocking");
    expect(f.message).toContain("0 to 11 months");
    expect(codesOf(ageGroups(matchedCtx((m) => { m.questions[0].constraint.min = 3; })))).toContain("AGE_LIMITS_EXCLUDE_SCOPE");
    // limits exactly the covered ages are fine
    expect(codesOf(ageGroups(matchedCtx((m) => { m.questions[0].constraint.min = 2; m.questions[0].constraint.max = 59; })))).not.toContain("AGE_LIMITS_EXCLUDE_SCOPE");
  });
  it("blocks a medicine whose quoted dose rows are by age but that has no dose table (M41)", () => {
    const fs = ageGroups(matchedCtx((m) => {
      const a = m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions[0];
      delete a.dose_by_age;
      a.source = [{ page: 9, quote: "Give twice daily for 5 days:\nAge 2 months up to 12 months—1 tablet (total 10 tabs)\nAge 12 months up to 5 years—2 tablets (total 20 tabs)" }];
    }));
    const f = fs.find((x) => x.code === "DOSE_TABLE_MISSING")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "outcome", id: "treat_fast_breathing_at_home" }]);
    expect(f.message).toContain("page 9");
  });
  it("a dose row in the action's own text counts too; an action without dose rows needs no table", () => {
    expect(codesOf(ageGroups(matchedCtx((m) => {
      const a = m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions[0];
      delete a.dose_by_age;
      a.text = "Give twice daily for 5 days: Age 2 months up to 12 months—1 tablet; Age 12 months up to 5 years—2 tablets";
    })))).toContain("DOSE_TABLE_MISSING");
    expect(codesOf(ageGroups(matchedCtx((m) => {
      delete m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").actions[0].dose_by_age;
    })))).not.toContain("DOSE_TABLE_MISSING");
  });
});
