import { describe, expect, it } from "vitest";
import { inclusivityWording } from "../../src/validation/checks/inclusivityWording.js";
import { matchedCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void) => inclusivityWording(matchedCtx(mutate));
/** Rewrite the danger-sign cough line: atom op and the quote the calculated value cites. */
const danger = (op: "at_least" | "less_than", quote: string) => (m: any) => {
  const d = m.derived.find((x: any) => x.id === "danger_sign");
  d.definition.any[0].all[1] = { field: "cough_days", op, value: 14 };
  d.source = [{ page: 6, quote }];
};
const codes = (mutate?: (m: any) => void) => run(mutate).map((f) => f.code);

describe("inclusivityWording on v1.json", () => {
  it("agrees with the booklet except the reading of 'up to 5 years' (60 months), flagged once for each value that ends there", () => {
    const fs = run();
    expect(fs.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(fs.map((f) => f.code)).toEqual(["INCLUSIVITY_ASSUMED", "INCLUSIVITY_ASSUMED"]);
    expect(fs.map((f) => f.subjects[0]!.id).sort()).toEqual(["fast_breathing", "outside_age_range"]);
    for (const f of fs) {
      expect(f.severity).toBe("info");
      expect(f.decidedBy).toBe("clinician");
      expect(f.params["number"]).toBe(60);
      expect(f.message).toContain("up to 5 years");
      expect(f.message).toContain("exactly 60 months");
    }
    expect(fs.find((f) => f.subjects[0]!.id === "fast_breathing")!.message).toContain("page 8");
    expect(fs.find((f) => f.subjects[0]!.id === "outside_age_range")!.message).toContain("page 3");
  });
  it("12 months is not flagged: the booklet's own row 'age 12 months up to 5 years' puts exactly 12 months in the higher group, and the item cites both rows", () => {
    expect(run().some((f) => f.params["number"] === 12)).toBe(false);
    // with only the first row cited the reading stays an assumption, pointing at Q1
    const f = run((m) => { m.derived.find((d: any) => d.id === "fast_breathing").source = [{ page: 8, quote: "In a child age 2 months up to 12 months, 50 breaths or more per minute" }]; }).find((x) => x.params["number"] === 12)!;
    expect(f.code).toBe("INCLUSIVITY_ASSUMED");
    expect(f.params["openQuestion"]).toBe("Q1");
    expect(f.message).toContain("Q1");
  });
});

describe("inclusivityWording phrases", () => {
  it.each(["Cough for 14 days or more", "Cough of at least 14 days", "Cough from 14 days", "Cough 14 days and above", "14 and over"])("'%s' agrees with at-least", (q) => {
    expect(codes(danger("at_least", q))).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it.each(["Cough for more than 14 days", "Cough over 14 days", "Cough above 14 days", "Cough greater than 14 days"])("'%s' with at-least 14 is a mismatch", (q) => {
    const f = run(danger("at_least", q)).find((x) => x.code === "INCLUSIVITY_MISMATCH")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.audience).toEqual(["clinician", "program_officer"]);
    expect(f.message).toContain("exactly 14");
    expect(f.message).toContain(q.match(/(more than|over|above|greater than) 14/)![0]);
  });
  it.each(["Cough less than 14 days", "Cough under 14 days", "Cough below 14 days", "Cough fewer than 14 days"])("'%s' agrees with less-than 14", (q) => {
    expect(codes(danger("less_than", q))).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it.each(["Cough 14 days or less", "Cough 14 days or fewer", "Cough of at most 14 days", "Cough no more than 14 days", "Cough 14 days and under"])("'%s' with less-than 14 is a mismatch (14 itself is included in the booklet)", (q) => {
    expect(codes(danger("less_than", q))).toContain("INCLUSIVITY_MISMATCH");
  });
  it("'up to 14' with less-than 14 is an assumption, not a mismatch", () => {
    const fs = run(danger("less_than", "Cough for up to 14 days"));
    expect(fs.map((f) => f.code)).toContain("INCLUSIVITY_ASSUMED");
    expect(fs.map((f) => f.code)).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it("the draft's two comparisons both put the number itself on the high side, so 'less than N' and 'N or more' are complements, not a mismatch", () => {
    expect(codes(danger("at_least", "Cough less than 14 days"))).not.toContain("INCLUSIVITY_MISMATCH");
    expect(codes(danger("less_than", "Cough 14 days or more"))).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it("a number with no inclusivity wording next to it raises nothing; so does a number absent from the quote", () => {
    expect(codes(danger("at_least", "Cough for 14 days"))).not.toContain("INCLUSIVITY_MISMATCH");
    expect(codes(danger("at_least", "Cough for weeks"))).toEqual(["INCLUSIVITY_ASSUMED", "INCLUSIVITY_ASSUMED"]);
  });
  it("uses the item's own quote near the same number, not another item's", () => {
    const fs = run((m) => { danger("at_least", "Cough for 14 days or more")(m); m.rules[1].source = [{ page: 8, quote: "Cough for more than 14 days" }]; });
    expect(fs.map((f) => f.code)).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it("one agreeing phrase beats a conflicting one for the same number", () => {
    expect(codes(danger("at_least", "Cough for 14 days or more (not more than 14 days at the clinic)"))).not.toContain("INCLUSIVITY_MISMATCH");
  });
  it("converts years to months: '5 years or more' agrees with at-least 60 months; 'more than 5 years' does not", () => {
    const set = (q: string) => (m: any) => { m.rules[1].when = { all: [{ field: "age_months", op: "at_least", value: 60 }] }; m.rules[1].source = [{ page: 3, quote: q }]; };
    expect(codes(set("child aged 5 years or more"))).not.toContain("INCLUSIVITY_MISMATCH");
    expect(codes(set("child older than 5 years"))).toContain("INCLUSIVITY_MISMATCH");
  });
  it("the words 'N up to M' mean N included and M excluded; 12 months up to 5 years agrees with at-least 12", () => {
    const set = (m: any) => { m.rules[1].when = { all: [{ field: "age_months", op: "at_least", value: 12 }, { field: "age_months", op: "less_than", value: 60 }] }; m.rules[1].source = [{ page: 8, quote: "age 12 months up to 5 years" }]; };
    const fs = run(set);
    expect(fs.filter((f) => f.code === "INCLUSIVITY_MISMATCH")).toEqual([]);
    expect(fs.filter((f) => f.code === "INCLUSIVITY_ASSUMED").map((f) => f.params["number"])).toContain(60);
  });
  it("tells in patient terms what a mismatch changes", () => {
    const f = run(danger("at_least", "Cough for more than 14 days")).find((x) => x.code === "INCLUSIVITY_MISMATCH")!;
    expect(f.message).toContain("14 or more");
    expect(f.message).toMatch(/does not include 14/);
    expect(f.message).toContain("page 6");
  });
  it("is deterministic", () => {
    expect(run().map((f) => f.id)).toEqual(run().map((f) => f.id));
  });
});

describe("inclusivityWording: direction of the comparison (red team 2: B22, B23, C5, C6)", () => {
  it.each([
    ["Cough for 14 days or more", "less_than"],
    ["Cough of at least 14 days", "less_than"],
    ["Cough for more than 14 days", "less_than"],
    ["Cough less than 14 days", "at_least"],
    ["Cough under 14 days", "at_least"],
    ["Cough below 14 days", "at_least"],
  ] as const)("'%s' with %s 14 is a blocking DIRECTION_MISMATCH", (q, op) => {
    const f = run(danger(op, q)).find((x) => x.code === "DIRECTION_MISMATCH")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toContain("14");
  });
  it.each([
    ["Cough for 14 days or more", "at_least"],
    ["Cough less than 14 days", "less_than"],
  ] as const)("'%s' with %s 14 agrees", (q, op) => {
    expect(codes(danger(op, q))).not.toContain("DIRECTION_MISMATCH");
  });
  it("C5/B23: fast breathing turned into fewer than 50 breaths is blocking", () => {
    const fs = run((m) => { m.derived[1].definition.all[1].any[0].all[2].op = "less_than"; });
    expect(fs.map((f) => f.code)).toContain("DIRECTION_MISMATCH");
  });
  it("age bands 'N up to M' agree with at least N and less than M; v1 has no direction finding", () => {
    expect(codes()).not.toContain("DIRECTION_MISMATCH");
  });
});
