import { describe, expect, it } from "vitest";
import { severityOrder } from "../../src/validation/checks/severityOrder.js";
import { codesOf, goldenCases, JARGON_RE, matchedCtx, realExtraction } from "./helpers.js";

const inv = (fs: { code: string }[]) => fs.filter((f) => f.code === "SEVERITY_INVERSION" || f.code === "SEVERITY_EXCEPTION_APPROVED");

describe("severityOrder", () => {
  it("the final model has no inversion: R1 (outside the ages AND a danger sign) is checked before R2 and the danger-sign rules, so the old hazard of open question Q2 is gone", () => {
    expect(codesOf(severityOrder({ ...matchedCtx(), goldenCases: goldenCases() }))).toEqual([]);
  });

  // The first model had no R1: its age-only rule R2 hid the danger-sign rules for a child outside the age range. Removing R1 brings that hazard back.
  const withoutR1 = (m: any) => { m.rules = m.rules.filter((r: any) => r.id !== "R1"); };

  it("still reports that hazard if R1 is taken away: R2 hides R3 and R4 for a child outside the age range with a danger sign (open question Q2)", () => {
    const fs = severityOrder({ ...matchedCtx(withoutR1), goldenCases: goldenCases() }).filter((f) => f.code === "SEVERITY_INVERSION");
    expect(codesOf(fs)).toEqual(["SEVERITY_INVERSION", "SEVERITY_INVERSION"]);
    const pairs = fs.map((f) => `${f.params["firstRule"]}>${f.params["overriddenRule"]}`).sort();
    expect(pairs).toEqual(["R2>R3", "R2>R4"]);
    for (const f of fs) {
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("clinician");
      expect(f.audience[0]).toBe("clinician");
      expect(f.message).toMatch(/a child aged (0 months|1 month|\d+ months)/);
      expect(f.message).toContain("Q2");
      expect(f.message).not.toMatch(JARGON_RE);
      expect(f.example).toBeDefined();
    }
    const r2r4 = fs.find((f) => f.params["overriddenRule"] === "R4")!;
    expect(r2r4.message).toMatch(/convulsions|danger sign|not able to drink|vomit|indrawing|sleepy|cough/i);
  });

  it("turns an approved pair into an information finding with who and why, leaving the other pair blocking", () => {
    const fs = severityOrder({
      ...matchedCtx(withoutR1),
      goldenCases: goldenCases(),
      approvedExceptions: [{ rules: ["R2", "R3"], by: "Dr Test", note: "Referred routinely outside the covered ages by local protocol" }],
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
        const a = m.rules.find((r: any) => r.id === "R3");
        const b = m.rules.find((r: any) => r.id === "R5");
        [a.priority, b.priority] = [b.priority, a.priority];
      }),
    );
    expect(inv(fs).some((f: any) => f.params["firstRule"] === "R5" && f.params["overriddenRule"] === "R3")).toBe(true);
  });
  it("finds the inversion when R2 (routine referral) is moved above R1 (urgent referral outside the ages): R2 would hide R1", () => {
    const fs = severityOrder(
      matchedCtx((m) => {
        const a = m.rules.find((r: any) => r.id === "R1");
        const b = m.rules.find((r: any) => r.id === "R2");
        [a.priority, b.priority] = [b.priority, a.priority];
      }),
    );
    expect(inv(fs).some((f: any) => f.params["firstRule"] === "R2" && f.params["overriddenRule"] === "R1")).toBe(true);
  });
  it("is silent when there are no inversions", () => {
    const fs = severityOrder({ ...matchedCtx((m) => { m.outcomes.find((o: any) => o.id === "refer_outside_age_range").severity = 1; }), goldenCases: goldenCases() });
    expect(fs).toEqual([]);
  });
});

const sev = (m: any, id: string, n: number) => { m.outcomes.find((o: any) => o.id === id).severity = n; };

describe("severityOrder: urgency ranks of the danger-sign results (red team 1)", () => {
  const run = (mutate?: (m: any) => void) => severityOrder({ ...matchedCtx(mutate), goldenCases: goldenCases(), extraction: realExtraction() });

  it("blocks a danger-sign result ranked below the most urgent rank (M19)", () => {
    const fs = run((m) => sev(m, "refer_urgent", 4));
    const f = fs.find((x) => x.code === "SEVERITY_DANGER_NOT_TOP")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "outcome", id: "refer_urgent" }]);
    expect(f.message).toContain("Danger sign: refer urgently");
    expect(f.message).not.toMatch(JARGON_RE);
    // ...and it now ties with the mild "cough without fast breathing"
    expect(codesOf(fs)).toContain("SEVERITY_NOT_SEPARATED");
  });

  it("blocks a milder result ranked as urgent as a danger-sign result", () => {
    const fs = run((m) => sev(m, "treat_fast_breathing_at_home", 1));
    const f = fs.find((x) => x.code === "SEVERITY_NOT_SEPARATED")!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "outcome", id: "treat_fast_breathing_at_home" });
    expect(f.message).toContain("Fast breathing (pneumonia)");
  });

  it("the result for children outside the covered ages may share the top rank", () => {
    expect(codesOf(run((m) => sev(m, "refer_outside_age_range", 1)))).toEqual([]);
  });

  it("blocks when every result has the same rank (M22)", () => {
    const fs = run((m) => { for (const o of m.outcomes) o.severity = 5; });
    expect(codesOf(fs)).toContain("SEVERITY_ALL_EQUAL");
    // without any danger-sign result the equal ranks still block
    const plain = severityOrder({ ...matchedCtx((m) => { for (const o of m.outcomes) o.severity = 5; m.derived[2].id = "sign_any"; m.derived[2].label = "Any sign"; for (const r of m.rules) if (r.when !== "otherwise") r.when = JSON.parse(JSON.stringify(r.when).split('"danger_sign"').join('"sign_any"')); }) });
    expect(codesOf(plain)).toContain("SEVERITY_ALL_EQUAL");
  });

  it("decides which results are referrals from the rules, not from the word refer (M33)", () => {
    const fs = run((m) => {
      const o = m.outcomes.find((x: any) => x.id === "refer_urgent");
      o.title = "Danger sign: advise fluids at home";
      o.severity = 4;
    });
    expect(codesOf(fs)).toContain("SEVERITY_DANGER_NOT_TOP");
  });

  it("a mild rule that reads a danger sign makes its result a danger-sign result (M12)", () => {
    const fs = run((m) => {
      m.rules.find((r: any) => r.id === "R6").when = { any: [{ field: "cough", op: "is_yes" }, { field: "convulsions", op: "is_yes" }] };
    });
    expect(fs.find((x) => x.code === "SEVERITY_DANGER_NOT_TOP")!.subjects).toEqual([{ kind: "outcome", id: "cough_no_fast_breathing" }]);
  });
});

describe("severityOrder: equally urgent results that overlap need a test case (red team 1, M81)", () => {
  it("blocks when no test case pins which of two equally urgent results a child gets", () => {
    const fs = severityOrder(matchedCtx());
    const f = fs.find((x) => x.code === "URGENT_OVERLAP_UNTESTED")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toMatch(/a child aged/);
    expect(f.message).not.toMatch(JARGON_RE);
    // R1 (outside the ages, danger sign), R3 (danger sign with fast breathing or indrawing) and R4 (any danger sign) are equally urgent and overlap in pairs
    const pairs = severityOrder(matchedCtx()).filter((x) => x.code === "URGENT_OVERLAP_UNTESTED").map((x) => x.subjects.map((y) => y.id).join("+")).sort();
    expect(pairs).toEqual(["R1+R3", "R1+R4", "R3+R4"]);
  });
  it("is satisfied by a test case where both apply and the first decides", () => {
    expect(codesOf(severityOrder({ ...matchedCtx(), goldenCases: goldenCases() }))).not.toContain("URGENT_OVERLAP_UNTESTED");
    const only = goldenCases((g) => g.splice(0, g.length, ...g.filter((c: any) => ["g12", "g15", "g17"].includes(c.id))));
    expect(codesOf(severityOrder({ ...matchedCtx(), goldenCases: only }))).not.toContain("URGENT_OVERLAP_UNTESTED");
    // one case pins only its own pair: g12 (chest indrawing, R3 over R4) leaves both R1 pairs open
    const g12 = goldenCases((g) => g.splice(0, g.length, ...g.filter((c: any) => c.id === "g12")));
    expect(severityOrder({ ...matchedCtx(), goldenCases: g12 }).filter((x) => x.code === "URGENT_OVERLAP_UNTESTED").map((x) => x.subjects.map((y) => y.id).join("+")).sort()).toEqual(["R1+R3", "R1+R4"]);
    const none = goldenCases((g) => g.splice(0, g.length, ...g.filter((c: any) => c.id === "g01")));
    expect(codesOf(severityOrder({ ...matchedCtx(), goldenCases: none }))).toContain("URGENT_OVERLAP_UNTESTED");
  });
  it("the proposed test cases include an infant with a danger sign and fast breathing, which catches M81", async () => {
    const { goldenCasesCheck } = await import("../../src/validation/checks/goldenCases.js");
    const g = goldenCases().find((c) => c.answers["age_months"] !== undefined && (c.answers["age_months"] as number) < 12 && c.expected_outcome === "refer_urgent_with_antibiotic" && (c.answers["breaths_per_minute"] as number) >= 50);
    expect(g).toBeDefined();
    const fs = goldenCasesCheck({ ...matchedCtx((m) => { m.rules.find((r: any) => r.id === "R3").when.all.push({ field: "age_months", op: "at_least", value: 12 }); }), goldenCases: goldenCases() });
    expect(fs.filter((f) => f.code === "GOLDEN_MISMATCH").map((f) => f.params["id"])).toContain(g!.id);
  });
});
