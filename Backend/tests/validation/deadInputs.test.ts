import { describe, expect, it } from "vitest";
import { deadInputs } from "../../src/validation/checks/deadInputs.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

const extra = (m: any, id: string, order: number, more: object = {}) =>
  m.questions.push({ id, order, label: `Question ${id}?`, answer_type: "yes_no", required: true, origin: "team", ...more });

describe("deadInputs", () => {
  it("passes v1: every question can change the result", () => expect(deadInputs(matchedCtx())).toEqual([]));
  it("warns about a question that never changes any result", () => {
    const fs = deadInputs(matchedCtx((m) => extra(m, "shoe_size", 10)));
    expect(codesOf(fs)).toEqual(["DEAD_INPUT"]);
    expect(fs[0]!.severity).toBe("warning");
    expect(fs[0]!.subjects).toContainEqual({ kind: "question", id: "shoe_size" });
    expect(fs[0]!.message).toContain("Question shoe_size?");
    expect(fs[0]!.message).not.toMatch(JARGON_RE);
  });
  it("does not call a question dead when it only decides whether another question is asked", () => {
    const fs = deadInputs(
      matchedCtx((m) => {
        extra(m, "gate", 10);
        extra(m, "detail", 11, { shown_when: { field: "gate", op: "is_yes" } });
        m.rules.find((r: any) => r.id === "R5").when = { any: [{ field: "cough", op: "is_yes" }, { all: [{ field: "gate", op: "is_yes" }, { field: "detail", op: "is_yes" }] }] };
      }),
    );
    expect(fs).toEqual([]);
  });
});
