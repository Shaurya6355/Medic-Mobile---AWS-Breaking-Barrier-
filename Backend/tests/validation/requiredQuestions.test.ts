import { describe, expect, it } from "vitest";
import { requiredQuestions } from "../../src/validation/checks/requiredQuestions.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

describe("requiredQuestions", () => {
  it("on v1: only the information note about counts that cannot be recorded as unmeasurable", () => {
    const fs = requiredQuestions(matchedCtx());
    expect(codesOf(fs)).toEqual(["UNMEASURABLE_NOT_SUPPORTED"]);
    const f = fs[0]!;
    expect(f.severity).toBe("info");
    expect(f.params["questions"]).toContain("Count the child's breaths in 1 minute");
    expect(f.subjects).toContainEqual({ kind: "question", id: "breaths_per_minute" });
    expect(f.message).toMatch(/could not be measured|cannot be measured|could not measure/i);
    expect(f.message).not.toMatch(JARGON_RE);
  });
  it("blocks a question that decides the result but may be skipped, and says a skipped answer counts as normal", () => {
    const fs = requiredQuestions(matchedCtx((m) => { m.questions.find((q: any) => q.id === "breaths_per_minute").required = false; }));
    const b = fs.filter((f) => f.code === "REQUIRED_QUESTION_OPTIONAL");
    expect(b).toHaveLength(1);
    expect(b[0]!.severity).toBe("blocking");
    expect(b[0]!.subjects).toContainEqual({ kind: "question", id: "breaths_per_minute" });
    expect(b[0]!.message).toMatch(/normal/);
    expect(b[0]!.message).not.toMatch(JARGON_RE);
    expect(b[0]!.source.length).toBeGreaterThan(0);
  });
  it("ignores optional questions that no rule reads", () => {
    const fs = requiredQuestions(
      matchedCtx((m) => { m.questions.push({ id: "note", order: 20, label: "Any note?", answer_type: "yes_no", required: false, origin: "team" }); }),
    );
    expect(codesOf(fs)).toEqual(["UNMEASURABLE_NOT_SUPPORTED"]);
  });
});
