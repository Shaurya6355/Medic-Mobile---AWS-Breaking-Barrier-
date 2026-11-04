import { describe, expect, it } from "vitest";
import {
  ageBandXpath,
  conditionToXpath,
  constraintXpath,
  derivedCalculation,
  flowRelevanceToXpath,
  formatNumber,
  outcomeCalculation,
  outcomeRelevant,
  XpathError,
} from "../../src/compiler/xpath.js";

const ctx = { derived: new Set(["danger_sign", "fast_breathing"]) };

describe("formatNumber", () => {
  it("prints integers and decimals in plain decimal", () => {
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-5)).toBe("-5");
    expect(formatNumber(37.5)).toBe("37.5");
  });
  it("never uses exponent notation", () => {
    expect(formatNumber(1e21)).toBe("1000000000000000000000");
    expect(formatNumber(1e-7)).toBe("0.0000001");
    expect(formatNumber(2.5e-10)).toBe("0.00000000025");
  });
  it("rejects non-finite numbers", () => {
    expect(() => formatNumber(Number.NaN)).toThrow(XpathError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(XpathError);
  });
  it("prints negative zero as 0", () => {
    expect(formatNumber(-0)).toBe("0");
  });
});

describe("conditionToXpath", () => {
  it("is_yes", () => {
    expect(conditionToXpath({ field: "cough", op: "is_yes" }, ctx)).toBe("${cough} = 'yes'");
  });
  it("at_least guards against empty", () => {
    expect(conditionToXpath({ field: "age_months", op: "at_least", value: 2 }, ctx)).toBe(
      "(${age_months} != '' and ${age_months} >= 2)",
    );
  });
  it("less_than guards against empty", () => {
    expect(conditionToXpath({ field: "age_months", op: "less_than", value: 60 }, ctx)).toBe(
      "(${age_months} != '' and ${age_months} < 60)",
    );
  });
  it("prints number literals in plain decimal", () => {
    expect(conditionToXpath({ field: "x", op: "less_than", value: 1e-7 }, ctx)).toBe(
      "(${x} != '' and ${x} < 0.0000001)",
    );
  });
  it("all joins with and, parenthesised", () => {
    expect(
      conditionToXpath(
        { all: [{ field: "cough", op: "is_yes" }, { field: "cough_days", op: "at_least", value: 14 }] },
        ctx,
      ),
    ).toBe("(${cough} = 'yes' and (${cough_days} != '' and ${cough_days} >= 14))");
  });
  it("any joins with or, parenthesised", () => {
    expect(
      conditionToXpath({ any: [{ field: "convulsions", op: "is_yes" }, { field: "vomits_everything", op: "is_yes" }] }, ctx),
    ).toBe("(${convulsions} = 'yes' or ${vomits_everything} = 'yes')");
  });
  it("a single-child all is still parenthesised", () => {
    expect(conditionToXpath({ all: [{ field: "cough", op: "is_yes" }] }, ctx)).toBe("(${cough} = 'yes')");
  });
  it("a derived id is read as a yes/no calculate", () => {
    expect(conditionToXpath({ field: "danger_sign", op: "is_yes" }, ctx)).toBe("${danger_sign} = 'yes'");
  });
  it("a numeric comparison on a derived id is refused", () => {
    expect(() => conditionToXpath({ field: "danger_sign", op: "at_least", value: 1 }, ctx)).toThrow(XpathError);
  });
  it("nests", () => {
    expect(
      conditionToXpath(
        {
          all: [
            { field: "danger_sign", op: "is_yes" },
            { any: [{ field: "fast_breathing", op: "is_yes" }, { field: "chest_indrawing", op: "is_yes" }] },
          ],
        },
        ctx,
      ),
    ).toBe("(${danger_sign} = 'yes' and (${fast_breathing} = 'yes' or ${chest_indrawing} = 'yes'))");
  });
  it("never emits not()", () => {
    const x = conditionToXpath(
      { any: [{ all: [{ field: "a", op: "less_than", value: 1 }] }, { field: "b", op: "is_yes" }] },
      ctx,
    );
    expect(x).not.toMatch(/not\(/);
  });
});

describe("derivedCalculation", () => {
  it("wraps the condition in if(…, 'yes', 'no')", () => {
    expect(derivedCalculation({ field: "cough", op: "is_yes" }, ctx)).toBe("if(${cough} = 'yes', 'yes', 'no')");
  });
});

describe("outcomeCalculation", () => {
  it("nests if() in ascending priority with otherwise as the final else", () => {
    const rules = [
      { priority: 3, when: { field: "danger_sign", op: "is_yes" } as const, outcome: "refer_urgent" },
      { priority: 9, when: "otherwise" as const, outcome: "no_cough" },
      { priority: 1, when: { field: "age_months", op: "less_than", value: 2 } as const, outcome: "outside" },
    ];
    expect(outcomeCalculation(rules, ctx)).toBe(
      "if((${age_months} != '' and ${age_months} < 2), 'outside', if(${danger_sign} = 'yes', 'refer_urgent', 'no_cough'))",
    );
  });
  it("an otherwise-only rule set is the bare outcome id", () => {
    expect(outcomeCalculation([{ priority: 1, when: "otherwise", outcome: "only" }], ctx)).toBe("'only'");
  });
  it("refuses a rule set without exactly one otherwise", () => {
    expect(() =>
      outcomeCalculation([{ priority: 1, when: { field: "a", op: "is_yes" }, outcome: "x" }], ctx),
    ).toThrow(XpathError);
  });
});

describe("constraintXpath", () => {
  it("min and max inclusive", () => {
    expect(constraintXpath(0, 120)).toBe(". >= 0 and . <= 120");
  });
});

describe("ageBandXpath and outcomeRelevant", () => {
  it("age band on age_months", () => {
    expect(ageBandXpath("age_months", 2, 12)).toBe(
      "(${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 12)",
    );
  });
  it("outcome relevant", () => {
    expect(outcomeRelevant("refer_urgent")).toBe("${outcome} = 'refer_urgent'");
  });
});

describe("flowRelevanceToXpath (flow-only conditions)", () => {
  it("is_no emits = 'no' (never not())", () => {
    expect(flowRelevanceToXpath({ field: "convulsions", op: "is_no" }, ctx)).toBe("${convulsions} = 'no'");
  });
  it("'never' emits false()", () => {
    expect(flowRelevanceToXpath("never", ctx)).toBe("false()");
  });
  it("null (no restriction) emits nothing", () => {
    expect(flowRelevanceToXpath(null, ctx)).toBeUndefined();
  });
  it("model atoms keep their exact emission, including the empty-field guards", () => {
    expect(
      flowRelevanceToXpath(
        {
          all: [
            { field: "age_months", op: "at_least", value: 2 },
            { field: "age_months", op: "less_than", value: 60 },
            { field: "convulsions", op: "is_no" },
            { any: [{ field: "cough", op: "is_no" }, { field: "cough", op: "is_yes" }] },
          ],
        },
        ctx,
      ),
    ).toBe(
      "((${age_months} != '' and ${age_months} >= 2) and (${age_months} != '' and ${age_months} < 60) and ${convulsions} = 'no' and (${cough} = 'no' or ${cough} = 'yes'))",
    );
  });
  it("refuses is_no on a derived value (the flow only reads questions)", () => {
    expect(() => flowRelevanceToXpath({ field: "danger_sign", op: "is_no" }, ctx)).toThrow(XpathError);
  });
});
