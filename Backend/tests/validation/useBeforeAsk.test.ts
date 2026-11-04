import { describe, expect, it } from "vitest";
import { useBeforeAsk } from "../../src/validation/checks/useBeforeAsk.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

describe("useBeforeAsk", () => {
  it("passes v1: the breath count is only read under the cough guard", () => {
    expect(useBeforeAsk(matchedCtx())).toEqual([]);
  });
  it("accepts a guard supplied by another calculated value that encodes it", () => {
    const fs = useBeforeAsk(
      matchedCtx((m) => {
        m.derived.unshift({ id: "has_cough", label: "Has cough", definition: { field: "cough", op: "is_yes" }, origin: "team" });
        m.derived.find((d: any) => d.id === "fast_breathing").definition = {
          all: [{ field: "has_cough", op: "is_yes" }, ...m.derived.find((d: any) => d.id === "fast_breathing").definition.all.slice(1)],
        };
      }),
    );
    expect(fs).toEqual([]);
  });
  it("accepts a guard implied by a stronger test on the same question (cough for 14 days or more implies cough)", () => {
    const fs = useBeforeAsk(
      matchedCtx((m) => {
        m.derived.find((d: any) => d.id === "fast_breathing").definition = {
          all: [{ field: "cough_days", op: "at_least", value: 3 }, { field: "breaths_per_minute", op: "at_least", value: 50 }],
        };
      }),
    );
    expect(fs).toEqual([]);
  });
  it("blocks the unguarded mutation: guard removed from fast breathing", () => {
    const fs = useBeforeAsk(
      matchedCtx((m) => {
        const d = m.derived.find((x: any) => x.id === "fast_breathing");
        d.definition = d.definition.all[1];
      }),
    );
    expect(codesOf(fs)).toEqual(["USE_BEFORE_ASK"]);
    const f = fs[0]!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "question", id: "breaths_per_minute" });
    expect(f.subjects).toContainEqual({ kind: "derived", id: "fast_breathing" });
    expect(f.message).toMatch(/not asked|never asked|skipped/i);
    expect(f.message).toMatch(/a child aged \d+ months?/);
    expect(f.message).toContain("Does the child have a cough?");
    expect(f.message).not.toMatch(JARGON_RE);
    expect(f.example).toBeDefined();
  });
  it("blocks a guard that sits in an any (an alternative does not guarantee the question was asked)", () => {
    const fs = useBeforeAsk(
      matchedCtx((m) => {
        m.rules.find((r: any) => r.id === "R5").when = { any: [{ field: "cough", op: "is_yes" }, { field: "breaths_per_minute", op: "at_least", value: 50 }] };
      }),
    );
    expect(codesOf(fs)).toEqual(["USE_BEFORE_ASK"]);
    expect(fs[0]!.subjects).toContainEqual({ kind: "rule", id: "R5" });
  });
  it("blocks a rule that reads the number of days without the cough question", () => {
    const fs = useBeforeAsk(matchedCtx((m) => { m.rules.find((r: any) => r.id === "R3").when = { field: "cough_days", op: "at_least", value: 14 }; }));
    expect(codesOf(fs)).toEqual(["USE_BEFORE_ASK"]);
  });
  it("does not flag a test that could not tell the difference (cannot be true within the entry limits)", () => {
    const fs = useBeforeAsk(matchedCtx((m) => { m.rules.find((r: any) => r.id === "R3").when = { field: "cough_days", op: "at_least", value: 4000 }; }));
    expect(fs).toEqual([]);
  });
});
