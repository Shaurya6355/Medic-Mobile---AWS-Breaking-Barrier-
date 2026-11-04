import { describe, expect, it } from "vitest";
import { severityOrder } from "../../src/validation/checks/severityOrder.js";
import { codesOf, JARGON_RE, matchedCtx } from "./helpers.js";

describe("severityOrder", () => {
  it("reports the real v1 hazard (open question Q2): R1 hides R2 and R3 for a child outside the age range with a danger sign", () => {
    const fs = severityOrder(matchedCtx());
    expect(codesOf(fs)).toEqual(["SEVERITY_INVERSION", "SEVERITY_INVERSION"]);
    const pairs = fs.map((f) => `${f.params["firstRule"]}>${f.params["overriddenRule"]}`).sort();
    expect(pairs).toEqual(["R1>R2", "R1>R3"]);
    for (const f of fs) {
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("clinician");
      expect(f.audience[0]).toBe("clinician");
      expect(f.message).toMatch(/a child aged (1 month|\d+ months)/);
      expect(f.message).toContain("Q2");
      expect(f.message).not.toMatch(JARGON_RE);
      expect(f.example).toBeDefined();
    }
    const r1r3 = fs.find((f) => f.params["overriddenRule"] === "R3")!;
    expect(r1r3.message).toMatch(/convulsions|danger sign|not able to drink|vomit|indrawing|sleepy|cough/i);
  });

  it("turns an approved pair into an information finding with who and why, leaving the other pair blocking", () => {
    const fs = severityOrder({
      ...matchedCtx(),
      approvedExceptions: [{ rules: ["R1", "R2"], by: "Dr Test", note: "Referred routinely outside the covered ages by local protocol" }],
    });
    const ok = fs.find((f) => f.code === "SEVERITY_EXCEPTION_APPROVED")!;
    expect(ok.severity).toBe("info");
    expect(ok.params["by"]).toBe("Dr Test");
    expect(ok.message).toContain("Dr Test");
    expect(ok.message).toContain("Referred routinely");
    expect(codesOf(fs).filter((c) => c === "SEVERITY_INVERSION")).toHaveLength(1);
  });

  it("finds a new inversion after swapping priorities (less urgent rule moved above a more urgent one)", () => {
    const fs = severityOrder(
      matchedCtx((m) => {
        const a = m.rules.find((r: any) => r.id === "R2");
        const b = m.rules.find((r: any) => r.id === "R4");
        [a.priority, b.priority] = [b.priority, a.priority];
      }),
    );
    expect(fs.some((f) => f.params["firstRule"] === "R4" && f.params["overriddenRule"] === "R2")).toBe(true);
  });
  it("is silent when there are no inversions", () => {
    const fs = severityOrder(matchedCtx((m) => { m.outcomes.find((o: any) => o.id === "refer_outside_age_range").severity = 1; }));
    expect(fs).toEqual([]);
  });
});
