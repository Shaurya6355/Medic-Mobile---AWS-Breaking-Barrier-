import { describe, expect, it } from "vitest";
import { closedTable } from "../../src/validation/checks/closedTable.js";
import { reachability } from "../../src/validation/checks/reachability.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

describe("closedTable", () => {
  it("passes v1: the last rule is the catch-all and every combination of answers gets a result", () => {
    expect(closedTable(matchedCtx())).toEqual([]);
  });

  it("reports a missing catch-all and the children who would get no result", () => {
    const fs = closedTable(matchedCtx((m) => { m.rules = m.rules.filter((r: any) => r.id !== "R7"); }));
    expect(codesOf(fs)).toEqual(["TABLE_NOT_CLOSED", "UNCOVERED_ANSWERS"]);
    for (const f of fs) {
      expect(f.severity).toBe("blocking");
      expect(f.message).not.toMatch(JARGON_RE);
    }
    const gap = fs.find((f) => f.code === "UNCOVERED_ANSWERS")!;
    expect(gap.message).toMatch(/a child aged \d+ months?/);
    expect(gap.decidedBy).toBe("clinician");
    expect(gap.example).toBeDefined();
  });

  it("reports a catch-all that is not checked last (swapped priorities)", () => {
    const fs = closedTable(
      matchedCtx((m) => {
        const r1 = m.rules.find((r: any) => r.id === "R1");
        const r7 = m.rules.find((r: any) => r.id === "R7");
        [r1.priority, r7.priority] = [r7.priority, r1.priority];
      }),
    );
    expect(codesOf(fs)).toEqual(["TABLE_NOT_CLOSED"]);
  });

  it("never passes silently when the combinations of answers cannot all be checked: NOT_PROVEN with the reason", () => {
    const fs = closedTable({ ...matchedCtx(), maxGridPoints: 50 });
    expect(codesOf(fs)).toEqual(["NOT_PROVEN"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.message).toMatch(/too many|too large|more than/i);
    expect(fs[0]!.message).not.toMatch(JARGON_RE);
  });

  it("other analysis checks stay silent (not wrong) when nothing is proven, because NOT_PROVEN already says so", () => {
    expect(reachability({ ...matchedCtx(), maxGridPoints: 50 })).toEqual([]);
  });

  it("is NOT_PROVEN when the draft refers to something that does not exist", () => {
    const fs = closedTable(matchedCtx((m) => { m.rules[3].when = { field: "ghost", op: "is_yes" }; }));
    expect(codesOf(fs)).toEqual(["NOT_PROVEN"]);
  });
});
