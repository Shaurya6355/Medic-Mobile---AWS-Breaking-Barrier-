import { describe, expect, it } from "vitest";
import { boundaryCards, boundaryCardsCheck } from "../../src/validation/checks/boundaryCards.js";
import { JARGON_RE, matchedCtx, v1Copy } from "./helpers.js";

describe("boundaryCards", () => {
  it("builds one card per threshold of v1, in a stable order", () => {
    const cards = boundaryCards(v1Copy());
    expect(cards.map((c) => `${c.field}@${c.threshold}`)).toEqual([
      "age_months@2", "age_months@12", "age_months@60", "cough_days@14", "breaths_per_minute@40", "breaths_per_minute@50",
    ]);
    expect(boundaryCards(v1Copy())).toEqual(cards);
  });
  it("shows what a breath count of 49, 50 and 51 does for a young infant with a cough", () => {
    const c = boundaryCards(v1Copy()).find((x) => x.field === "breaths_per_minute" && x.threshold === 50)!;
    expect(c.label).toBe("Count the child's breaths in 1 minute");
    expect(c.cases.map((x) => x.value)).toEqual([49, 50, 51]);
    expect(c.cases.map((x) => x.outcome)).toEqual(["cough_no_fast_breathing", "treat_fast_breathing_at_home", "treat_fast_breathing_at_home"]);
    expect(c.cases.map((x) => x.rule)).toEqual(["R6", "R5", "R5"]);
    expect(c.cases.map((x) => x.derived["fast_breathing"])).toEqual([false, true, true]);
  });
  it("shows exactly 12 months landing in the older band", () => {
    const c = boundaryCards(v1Copy()).find((x) => x.field === "age_months" && x.threshold === 12)!;
    expect(c.cases.map((x) => x.value)).toEqual([11, 12, 13]);
    expect(c.cases.map((x) => x.derived["fast_breathing"])).toEqual([false, true, true]);
  });
  it("shows the cough-days cut-off at 14 days", () => {
    const c = boundaryCards(v1Copy()).find((x) => x.field === "cough_days")!;
    expect(c.cases.map((x) => x.outcome)[0]).not.toBe(c.cases.map((x) => x.outcome)[1]);
  });
  it("gives one BOUNDARY_SHOWN info finding per threshold, with the three results in plain words", () => {
    const fs = boundaryCardsCheck(matchedCtx());
    expect(fs).toHaveLength(6);
    for (const f of fs) {
      expect(f.code).toBe("BOUNDARY_SHOWN");
      expect(f.severity).toBe("info");
      expect(f.audience).toContain("clinician");
      expect(f.message).not.toMatch(JARGON_RE);
    }
    const f50 = fs.find((f) => f.params["threshold"] === 50)!;
    expect(f50.message).toContain("treat at home");
    expect(f50.message).toMatch(/a child aged 2 months/);
  });
  it("marks the 12 month boundary where two age bands meet, and refers to the open question", () => {
    const fs = boundaryCardsCheck(matchedCtx());
    const f12 = fs.find((f) => f.params["threshold"] === 12 && f.params["question"] === "Child's age in months")!;
    expect(f12.params["bandsMeet"]).toBe(true);
    expect(f12.message).toMatch(/two age bands meet/);
    expect(f12.message).toContain("Q1");
    // 60 months: the fast-breathing bands end where the out-of-range value starts, so the bands do meet there
    const f60 = fs.find((f) => f.params["threshold"] === 60)!;
    expect(f60.params["bandsMeet"]).toBe(true);
    expect(f60.message).toMatch(/exactly 60 months is counted in the older band/);
  });
  it("names an open question only at the cut-off it is about (Q1 is about 12 months, not 2 or 60)", () => {
    const fs = boundaryCardsCheck(matchedCtx()).filter((f) => f.params["question"] === "Child's age in months");
    const q = (t: number) => fs.find((f) => f.params["threshold"] === t)!.params["openQuestion"];
    expect(q(12)).toBe("Q1");
    expect(q(2)).toBe("");
    expect(q(60)).toBe("");
    expect(fs.find((f) => f.params["threshold"] === 2)!.message).not.toMatch(/open question/);
  });
  it("shows the cough-days cut-off for a child inside the covered ages, not for an out-of-range child the age rules would catch first", () => {
    const c = boundaryCards(v1Copy()).find((x) => x.field === "cough_days")!;
    const age = c.baseline["age_months"] as number;
    expect(age).toBeGreaterThanOrEqual(2);
    expect(age).toBeLessThan(60);
    expect(c.cases.map((x) => x.outcome)).toEqual(["cough_no_fast_breathing", "refer_urgent", "refer_urgent"]);
  });
  it("still shows every age for the age cut-offs themselves (1, 2 and 3 months)", () => {
    const c = boundaryCards(v1Copy()).find((x) => x.field === "age_months" && x.threshold === 2)!;
    expect(c.cases.map((x) => x.outcome)).toEqual(["refer_outside_age_range", "no_cough", "no_cough"]);
  });
  it("writes 1 month, not 1 months", () => {
    const f = boundaryCardsCheck(matchedCtx()).find((x) => x.params["threshold"] === 2 && x.params["question"] === "Child's age in months")!;
    expect(f.message).toContain("1 month gives");
    expect(f.message).not.toContain("1 months");
    expect(f.message).toContain("2 months gives");
  });
  it("skips a threshold that lies outside the entry limits instead of inventing cases", () => {
    const cards = boundaryCards(v1Copy((m) => { m.rules[1].when = { all: [{ field: "danger_sign", op: "is_yes" }, { field: "breaths_per_minute", op: "at_least", value: 500 }] }; }));
    const c = cards.find((x) => x.threshold === 500);
    expect(c?.cases.length ?? 0).toBe(0);
  });
});
