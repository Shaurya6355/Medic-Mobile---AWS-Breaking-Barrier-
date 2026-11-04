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
