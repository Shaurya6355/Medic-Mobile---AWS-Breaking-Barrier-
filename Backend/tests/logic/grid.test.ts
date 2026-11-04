import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/logic/canonical.js";
import { analyzeRules, enumerateAnswers } from "../../src/logic/grid.js";
import { effectiveAnswers } from "../../src/logic/interpreter.js";
import { parseModel } from "../../src/logic/schema.js";
import { v1 } from "./helpers.js";

const m = v1();

describe("enumerateAnswers", () => {
  const g = enumerateAnswers(m);
  const values = (q: string): number[] =>
    [...new Set(g.points.map((p) => p[q]).filter((v): v is number => typeof v === "number"))].sort((a, b) => a - b);

  it("is exact for v1", () => {
    expect(g.exact).toBe(true);
    expect(g.reasons).toEqual([]);
    expect(g.estimated).toBe(g.points.length);
  });
  it("contains every threshold t and t-1, plus min and max (region representation is exact for at_least/less_than)", () => {
    expect(values("age_months")).toEqual([0, 1, 2, 11, 12, 59, 60, 120]);
    expect(values("breaths_per_minute")).toEqual([10, 39, 40, 49, 50, 120]);
    expect(values("cough_days")).toEqual([0, 13, 14, 365]);
  });
  it("hidden questions get no value and shown questions are always answered", () => {
    for (const p of g.points) {
      if (p.cough === true) {
        expect(typeof p.cough_days).toBe("number");
        expect(typeof p.breaths_per_minute).toBe("number");
      } else {
        expect("cough_days" in p).toBe(false);
        expect("breaths_per_minute" in p).toBe(false);
      }
    }
  });
  it("every point is a valid submission", () => {
    for (const p of g.points) expect(() => effectiveAnswers(m, p)).not.toThrow();
  });
  it("returns exact:false with a reason and the first maxPoints points when too large", () => {
    const small = enumerateAnswers(m, { maxPoints: 10 });
    expect(small.exact).toBe(false);
    expect(small.points).toHaveLength(10);
    expect(small.reasons.join()).toContain("maxPoints");
    expect(small.estimated).toBeGreaterThan(10);
    expect(canonicalJson(small.points)).toBe(canonicalJson(g.points.slice(0, 10)));
  });
  it("is deterministic", () => {
    expect(canonicalJson(enumerateAnswers(m))).toBe(canonicalJson(enumerateAnswers(m)));
  });
});

describe("analyzeRules", () => {
  const a = analyzeRules(m);
  it("is exact and finds no unreachable rules", () => {
    expect(a.exact).toBe(true);
    expect(a.unreachableRules).toEqual([]);
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      expect(a.perRule[id]!.first).toBeGreaterThan(0);
      expect(a.perRule[id]!.example).toBeDefined();
    }
  });
  it("first counts sum to points and outcome counts match", () => {
    const total = Object.values(a.perRule).reduce((s, r) => s + r.first, 0);
    expect(total).toBe(a.points);
    expect(Object.values(a.perOutcome).reduce((s, n) => s + n, 0)).toBe(a.points);
    expect(a.uncoveredByAnyRule).toBe(0);
  });
  it("R6 (otherwise) matches every point; R3 is shadowed sometimes but still first elsewhere", () => {
    expect(a.perRule["R6"]!.matched).toBe(a.points);
    expect(a.neverFirstButMatching).toEqual([]);
  });
  it("reports the hazard: R1 fires first for under-2-month children that also match R3", () => {
    const h = a.severityInversions.find((x) => x.firstRule === "R1" && x.overriddenRule === "R3");
    expect(h).toBeDefined();
    expect(h!.firstSeverity).toBe(2);
    expect(h!.overriddenSeverity).toBe(1);
    expect(h!.example["age_months"]).toBeLessThan(2);
  });
  it("detects an unreachable rule in a modified model", () => {
    const raw = JSON.parse(JSON.stringify(m));
    raw.rules[3].when = raw.rules[2].when; // R4 now identical to R3 -> shadowed
    const parsed = parseModel(raw);
    if (!parsed.ok) throw new Error(parsed.issues.join());
    const sh = analyzeRules(parsed.value);
    expect(sh.unreachableRules).toContain("R4");
    expect(sh.neverFirstButMatching).toContain("R4");
  });
  it("is deterministic", () => {
    expect(canonicalJson(analyzeRules(m))).toBe(canonicalJson(analyzeRules(m)));
  });
});

describe("cut-offs outside the entry limits are reported, not dropped silently (red team 1, M50, M53)", () => {
  it("lists every cut-off that no answer within the limits can reach on both sides", async () => {
    const { thresholdsOutsideLimits } = await import("../../src/logic/grid.js");
    expect(thresholdsOutsideLimits(m)).toEqual([]);
    const mm: any = structuredClone(m);
    mm.questions.find((q: any) => q.id === "breaths_per_minute").constraint.max = 45;
    mm.questions.find((q: any) => q.id === "cough_days").constraint.max = 13;
    const out = thresholdsOutsideLimits(mm);
    expect(out.map((x) => `${x.question}:${x.value}:${x.where}`).sort()).toEqual([
      "breaths_per_minute:50:derived:fast_breathing",
      "cough_days:14:derived:danger_sign",
    ]);
    expect(enumerateAnswers(mm).outsideLimits).toEqual(out);
  });
  it("a cut-off at the lowest allowed value is constant too (every answer is at least it)", async () => {
    const { thresholdsOutsideLimits } = await import("../../src/logic/grid.js");
    const mm: any = structuredClone(m);
    mm.questions.find((q: any) => q.id === "breaths_per_minute").constraint.min = 40;
    expect(thresholdsOutsideLimits(mm).map((x) => x.value)).toEqual([40]);
  });
});
