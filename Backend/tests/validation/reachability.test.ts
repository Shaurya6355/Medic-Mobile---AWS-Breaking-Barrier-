import { describe, expect, it } from "vitest";
import { exclusivity } from "../../src/validation/checks/exclusivity.js";
import { reachability } from "../../src/validation/checks/reachability.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

const swapPriorities = (m: any, a: string, b: string) => {
  const x = m.rules.find((r: any) => r.id === a);
  const y = m.rules.find((r: any) => r.id === b);
  [x.priority, y.priority] = [y.priority, x.priority];
};

describe("exclusivity (first match wins)", () => {
  it("passes v1", () => expect(exclusivity(matchedCtx())).toEqual([]));
  it("warns about a rule that is always hidden by a rule above it, with an example child", () => {
    const fs = exclusivity(matchedCtx((m) => swapPriorities(m, "R2", "R3")));
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("SHADOWED_RULE");
    expect(f.severity).toBe("warning");
    expect(f.subjects).toContainEqual({ kind: "rule", id: "R2" });
    expect(f.message).toMatch(/a child aged \d+ months?/);
    expect(f.message).toContain("R3");
    expect(f.message).not.toMatch(JARGON_RE);
  });
});

describe("reachability", () => {
  it("passes v1: every rule, result and question can come up, and both calculated values vary", () => {
    expect(reachability(matchedCtx())).toEqual([]);
  });
  it("blocks a rule that can never be true (UNREACHABLE_RULE) and the result only it gave", () => {
    const fs = reachability(
      matchedCtx((m) => {
        m.rules.find((r: any) => r.id === "R2").when = { all: [{ field: "danger_sign", op: "is_yes" }, { field: "age_months", op: "at_least", value: 500 }] };
      }),
    );
    // 500 months is above the age entry limit (120), which is reported as well
    expect(codesOf(fs).sort()).toEqual(["ENTRY_LIMIT_HIDES_CUTOFF", "UNREACHABLE_OUTCOME", "UNREACHABLE_RULE"]);
    const rule = fs.find((f) => f.code === "UNREACHABLE_RULE")!;
    expect(rule.severity).toBe("blocking");
    expect(rule.subjects).toContainEqual({ kind: "rule", id: "R2" });
    expect(rule.source.length).toBeGreaterThan(0);
    expect(rule.message).not.toMatch(JARGON_RE);
  });
  it("blocks a rule that is always preempted, and says so differently from a rule that is never true", () => {
    const fs = reachability(matchedCtx((m) => swapPriorities(m, "R2", "R3")));
    expect(codesOf(fs).sort()).toEqual(["UNREACHABLE_OUTCOME", "UNREACHABLE_RULE"]);
    expect(fs.find((f) => f.code === "UNREACHABLE_RULE")!.params["why"]).toBe("hidden");
  });
  it("blocks a declared result that no rule gives, and names its follow-up", () => {
    const fs = reachability(
      matchedCtx((m) => {
        const o = structuredClone(m.outcomes.find((x: any) => x.id === "treat_fast_breathing_at_home"));
        o.id = "spare_result";
        m.outcomes.push(o);
      }),
    );
    expect(codesOf(fs)).toEqual(["UNREACHABLE_OUTCOME"]);
    expect(fs[0]!.params["hasFollowUp"]).toBe(true);
    expect(fs[0]!.message).toMatch(/follow-up/i);
  });
  it("blocks a question that can never be asked", () => {
    const fs = reachability(
      matchedCtx((m) => {
        m.questions.find((q: any) => q.id === "cough_days").shown_when = { all: [{ field: "cough", op: "is_yes" }, { field: "age_months", op: "at_least", value: 500 }] };
      }),
    );
    expect(codesOf(fs).sort()).toEqual(["ENTRY_LIMIT_HIDES_CUTOFF", "QUESTION_NEVER_SHOWN"]);
    const f = fs.find((x) => x.code === "QUESTION_NEVER_SHOWN")!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "question", id: "cough_days" });
  });
  it("warns about a calculated value that is always yes or always no", () => {
    const fs = reachability(
      matchedCtx((m) => {
        m.derived.push({ id: "always_on", label: "Always on", definition: { field: "age_months", op: "at_least", value: 0 }, origin: "team" });
      }),
    );
    // "at least 0" with an entry limit starting at 0 never separates children, which also blocks
    expect(codesOf(fs).sort()).toEqual(["DERIVED_CONSTANT", "ENTRY_LIMIT_HIDES_CUTOFF"]);
    const f = fs.find((x) => x.code === "DERIVED_CONSTANT")!;
    expect(f.severity).toBe("warning");
    expect(f.params["always"]).toBe("yes");
  });
});

describe("entry limits that hide a cut-off (red team 1, M50, M53)", () => {
  it("blocks a cut-off that the entry limits make impossible to reach, naming the question and the limits", () => {
    const fs = reachability(matchedCtx((m) => { m.questions.find((q: any) => q.id === "breaths_per_minute").constraint.max = 45; }));
    const f = fs.find((x) => x.code === "ENTRY_LIMIT_HIDES_CUTOFF")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toContainEqual({ kind: "question", id: "breaths_per_minute" });
    expect(f.subjects).toContainEqual({ kind: "derived", id: "fast_breathing" });
    expect(f.message).toContain("50");
    expect(f.message).toContain("10 to 45");
    expect(f.message).not.toMatch(JARGON_RE);
  });
  it("blocks the chronic-cough cut-off hidden by a 13-day limit", () => {
    expect(codesOf(reachability(matchedCtx((m) => { m.questions.find((q: any) => q.id === "cough_days").constraint.max = 13; })))).toContain("ENTRY_LIMIT_HIDES_CUTOFF");
  });
  it("is silent for v1", () => {
    expect(codesOf(reachability(matchedCtx()))).not.toContain("ENTRY_LIMIT_HIDES_CUTOFF");
  });
});
