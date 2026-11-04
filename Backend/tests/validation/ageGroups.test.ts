import { describe, expect, it } from "vitest";
import { ageGroups } from "../../src/validation/checks/ageGroups.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseModel } from "../../src/logic/schema.js";
import { codesOf, JARGON_RE, matchedCtx, realDocument } from "./helpers.js";

/** The first, six-rule model (no out-of-range calculated value: its age rule reads the age question itself). */
function oldModelCtx(mutate?: (m: any) => void) {
  const r = parseModel(JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/validation/old-six-rule-v1.json"), "utf8")));
  if (!r.ok) throw new Error(r.issues.join("; "));
  const doc = realDocument();
  const m = structuredClone(r.value) as any;
  m.meta.guideline.file_sha256 = doc.docSha256;
  mutate?.(m);
  return { model: m, document: doc };
}
const outside = (m: any) => m.derived.find((d: any) => d.id === "outside_age_range").definition.any;

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

describe("ageGroups: a calculated value for children outside the covered ages", () => {
  it("the final model's outside_age_range (below 2, 60 and over) is no age-band gap: nothing at all is found", () => {
    const fs = ageGroups(matchedCtx());
    expect(codesOf(fs)).not.toContain("AGE_GAP");
    expect(fs).toEqual([]);
  });
  it("blocks when its upper band starts after the covered ages end (62 instead of 60), naming the ages left out", () => {
    const fs = ageGroups(matchedCtx((m) => { outside(m)[1].value = 62; }));
    expect(codesOf(fs)).toEqual(["OUTSIDE_AGE_BANDS_MISMATCH"]);
    const f = fs[0]!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "derived", id: "outside_age_range" }, { kind: "scope", id: "scope" }]);
    expect(f.params["range"]).toBe("60 up to 62 months");
    expect(f.message).toMatch(/outside the covered ages \(2 up to 60 months\)/);
    expect(f.message).toContain("60 up to 62 months");
    expect(f.message).not.toMatch(JARGON_RE);
    expect(f.source.length).toBeGreaterThan(0);
  });
  it("blocks when its lower band stops short of the covered ages (below 1 instead of below 2)", () => {
    const fs = ageGroups(matchedCtx((m) => { outside(m)[0].value = 1; }));
    expect(codesOf(fs)).toEqual(["OUTSIDE_AGE_BANDS_MISMATCH"]);
    expect(fs[0]!.params["range"]).toBe("1 up to 2 months");
  });
  it("blocks when its upper band has an end (60 up to 120): older children are left out", () => {
    const fs = ageGroups(matchedCtx((m) => { outside(m)[1] = { all: [{ field: "age_months", op: "at_least", value: 60 }, { field: "age_months", op: "less_than", value: 120 }] }; }));
    expect(codesOf(fs)).toEqual(["OUTSIDE_AGE_BANDS_MISMATCH"]);
    expect(fs[0]!.params["range"]).toBe("120 months and over");
  });
  it("accepts a value for one side only (children too young), and bands that overlap each other", () => {
    expect(codesOf(ageGroups(matchedCtx((m) => { m.derived.find((d: any) => d.id === "outside_age_range").definition = { field: "age_months", op: "less_than", value: 2 }; })))).toEqual([]);
    expect(codesOf(ageGroups(matchedCtx((m) => { outside(m).push({ field: "age_months", op: "at_least", value: 80 }); })))).toEqual([]);
  });
  it("a value that has one band inside the covered ages is a mixed value and keeps the old rule (an upper band from 58 leaves a gap 2 up to 58)", () => {
    const fs = ageGroups(matchedCtx((m) => { outside(m)[1].value = 58; }));
    expect(codesOf(fs)).toContain("AGE_GAP");
    expect(codesOf(fs)).not.toContain("OUTSIDE_AGE_BANDS_MISMATCH");
    expect(fs.find((f) => f.code === "AGE_GAP")!.severity).toBe("blocking");
  });
  it("a dose-list mismatch names the fast-breathing bands, not the bands of the out-of-range value", () => {
    const fs = ageGroups(matchedCtx((m) => {
      const a = m.outcomes.find((o: any) => o.id === "refer_urgent_with_antibiotic").actions.find((x: any) => x.dose_by_age);
      a.dose_by_age[0].age_months_below = 13;
      a.dose_by_age[1].age_months_min = 13;
    }));
    expect(codesOf(fs)).toEqual(["DOSE_BANDS_MISMATCH"]);
    expect(fs[0]!.params["ruleBands"]).toBe("2 up to 12 months, 12 up to 60 months");
    expect(fs[0]!.subjects).toContainEqual({ kind: "derived", id: "fast_breathing" });
  });
  it("the older six-rule model still passes, and its gap, overlap and short bands are still found", () => {
    expect(ageGroups(oldModelCtx())).toEqual([]);
    const fb = (m: any) => m.derived.find((d: any) => d.id === "fast_breathing").definition.all[1].any;
    expect(codesOf(ageGroups(oldModelCtx((m) => { fb(m)[0].all[1].value = 11; })))).toContain("AGE_GAP");
    expect(codesOf(ageGroups(oldModelCtx((m) => { fb(m)[1].all[0].value = 10; })))).toContain("AGE_OVERLAP");
    expect(codesOf(ageGroups(oldModelCtx((m) => { fb(m)[1].all[1].value = 48; })))).toContain("AGE_GAP");
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
