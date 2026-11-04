import { describe, expect, it } from "vitest";
import { groundNumber, tokenize } from "../../src/validation/numbers.js";

const g = (text: string, v: number, unit?: string, freq = false) => groundNumber(tokenize([text], freq), v, unit);

describe("groundNumber", () => {
  it("finds digits next to a compatible unit", () => {
    expect(g("Cough for 14 days or more", 14, "days").status).toBe("grounded");
    expect(g("50 breaths or more per minute", 50, "breaths/min").status).toBe("grounded");
  });
  it("finds number words, fractions and decimals", () => {
    expect(g("for five days", 5, "days").status).toBe("grounded");
    expect(g("give 1/2 tablet", 0.5, "tablet").status).toBe("grounded");
    expect(g("give 2.5 ml", 2.5, "ml").status).toBe("grounded");
  });
  it("treats once and twice as numbers only for times per day", () => {
    expect(g("twice daily", 2, undefined, true).status).toBe("grounded");
    expect(g("once a day", 1, undefined, true).status).toBe("grounded");
    expect(g("at least once a week", 1, "week").status).toBe("absent");
  });
  it("reports absent, wrong unit and missing unit", () => {
    expect(g("Cough for 14 days", 15, "days").status).toBe("absent");
    expect(g("Cough for 14 months", 14, "days")).toMatchObject({ status: "unit_mismatch" });
    expect(g("Cough 14 or more", 14, "days").status).toBe("no_unit");
  });
  it("does not let a neighbouring number lend its unit", () => {
    expect(g("age 2 months up to 12 months", 2, "days").status).toBe("unit_mismatch");
    expect(g("2 months up to 12 weeks", 12, "months").status).toBe("unit_mismatch");
  });
  it("uses the explicit conversion table and says so", () => {
    expect(g("12 months up to 5 years", 60, "months")).toMatchObject({ status: "converted", textValue: 5, textUnit: "year" });
    expect(g("in 1 week", 7, "days")).toMatchObject({ status: "converted" });
    expect(g("in 2 weeks", 14, "days")).toMatchObject({ status: "converted" });
    expect(g("age 1 year", 12, "months")).toMatchObject({ status: "converted" });
    expect(g("age 2 years", 24, "months")).toMatchObject({ status: "converted" });
    expect(g("age 12 months", 1, "years")).toMatchObject({ status: "converted" });
    expect(g("age 7 months", 1, "years").status).not.toBe("converted");
  });
  it("prefers a direct match to a conversion", () => {
    expect(g("12 months, 1 year", 12, "months").status).toBe("grounded");
  });
  it("skips the unit check for unitless numbers", () => {
    expect(g("Score of 3 or more", 3, undefined).status).toBe("grounded");
  });
  it("keeps separate text segments apart", () => {
    const t = tokenize(["Cough for 14", "days of rest"], false);
    expect(groundNumber(t, 14, "days").status).toBe("no_unit");
  });
});

describe("groundNumber hardening (red team 2)", () => {
  it("B7/B8: the unit must come right after the number, never borrowed from before or two words on", () => {
    expect(g("for 5 days 2", 2, "days").status).toBe("no_unit");
    expect(g("2 months up to 12", 12, "months").status).toBe("no_unit");
    expect(g("14 or more days", 14, "days").status).toBe("no_unit");
    expect(g("Cough for 14 days or more", 14, "days").status).toBe("grounded");
  });
  it("B3/B9: a number word counts only when a unit follows it", () => {
    expect(g("One or both parents have HIV", 1, undefined).status).toBe("absent");
    expect(g("twelve months", 12, "months").status).toBe("grounded");
    expect(g("Give one dose now", 1, "dose").status).toBe("grounded");
    expect(g("for five days", 5, "days").status).toBe("grounded");
  });
  it("B4: page numbers never count", () => {
    expect(g("Go to page 8", 8, undefined).status).toBe("absent");
    expect(g("(Go to page 10.)", 10, undefined).status).toBe("absent");
    expect(g("see pages 9 and 10", 9, undefined).status).toBe("absent");
  });
  it("B6: a decimal is one number; its digits after the point are not a number of their own", () => {
    expect(g("1.5 tablets", 5, "tablets").status).toBe("absent");
  });
  it("zero is a number like any other", () => {
    expect(g("in 0 days", 0, "days").status).toBe("grounded");
    expect(g("in 3 days", 0, "days").status).toBe("absent");
  });
});
