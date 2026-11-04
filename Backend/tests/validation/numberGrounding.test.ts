import { describe, expect, it } from "vitest";
import { numberGrounding } from "../../src/validation/checks/numberGrounding.js";
import { numbersInText } from "../../src/validation/checks/numberGrounding.js";
import { matchedCtx, realCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void) => numberGrounding(realCtx(mutate));
const codes = (mutate?: (m: any) => void) => run(mutate).map((f) => f.code);
const allBlocking = (mutate?: (m: any) => void) => run(mutate).filter((f) => f.severity === "blocking");
/** Blocking findings a change adds to what v1.json has by itself (v1's own quotes are thin, so it has a few). */
const blocking = (mutate?: (m: any) => void) => {
  const base = new Set(allBlocking().map((f) => f.id));
  return allBlocking(mutate).filter((f) => !base.has(f.id));
};

/** Fast breathing citing only the first booklet row (the 50 line), as the first draft did. */
const firstRowOnly = (m: any) => { m.derived.find((d: any) => d.id === "fast_breathing").source = [{ page: 8, quote: "In a child age 2 months up to 12 months, 50 breaths or more per minute" }]; };
/** The first model's shape: a team-owned rule that tests the age against the covered range itself. */
const teamAgeRule = (m: any) => { const r = m.rules.find((x: any) => x.id === "R2"); r.when = { any: [{ field: "age_months", op: "less_than", value: 2 }, { field: "age_months", op: "at_least", value: 60 }] }; delete r.source; r.origin = "team"; };

describe("numberGrounding on v1.json and the real booklet", () => {
  it("the final model's fast breathing cites both booklet rows, so none of its numbers is ungrounded", () => {
    expect(run().filter((f) => f.code === "UNGROUNDED_NUMBER" && f.subjects.some((s) => s.id === "fast_breathing"))).toEqual([]);
  });
  it("what the final model leaves ungrounded is exactly: the dose-list ages and quantities of the two antibiotic actions, and the 7-day follow-ups (content findings, not silenced)", () => {
    const fs = run().filter((f) => f.code === "UNGROUNDED_NUMBER");
    expect(fs).toHaveLength(17);
    const kinds = new Set(fs.map((f) => String(f.params["usage"]).replace(/\d+/g, "N")));
    expect(kinds).toEqual(new Set(["an age limit of N months in the dose table (N up to N months)", "a dose of N tablet for age N up to N months", "a dose of N tablets for age N up to N months", "a total of N tablets for age N up to N months", "a follow-up due after N days"]));
    expect(fs.filter((f) => /follow-up/.test(String(f.params["usage"]))).map((f) => f.params["number"])).toEqual([7, 7, 7]);
  });
  it("quote-only: the cited page is not consulted, so the 40 and 60 months of fast breathing are ungrounded when its quote cites only the 50 line", () => {
    const fs = run(firstRowOnly).filter((f) => f.code === "UNGROUNDED_NUMBER" && f.subjects.some((s) => s.id === "fast_breathing"));
    expect(fs.map((f) => f.params["number"]).sort()).toEqual([40, 60]);
    for (const f of fs) {
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("program_officer");
      expect(f.audience[0]).toBe("program_officer");
      expect(f.params["page"]).toBe("8");
    }
  });

  it("tells the program officer which passage of the cited page to add as a quote", () => {
    const f = run(firstRowOnly).find((x) => x.code === "UNGROUNDED_NUMBER" && x.params["number"] === 40 && x.subjects.some((s) => s.id === "fast_breathing"))!;
    expect(f.params["pageQuote"]).toContain("40 breaths or more per minute");
    expect(f.message).toContain("add");
    expect(f.message).toContain("40 breaths or more per minute");
    expect(f.message).toMatch(/quote/);
  });

  it("a number that is on the cited page but in none of the item's own quotes is ungrounded; adding that quote grounds it", () => {
    const fb = (mutate?: (m: any) => void) => allBlocking(mutate).filter((f) => f.subjects.some((s) => s.id === "fast_breathing"));
    expect(fb(firstRowOnly).map((f) => f.params["number"]).sort()).toEqual([40, 60]);
    const after = fb((m) => {
      firstRowOnly(m);
      m.derived[1].source.push({ page: 8, quote: "In a child age 12 months up to 5 years, 40 breaths or more per minute" });
    });
    expect(after).toEqual([]);
  });

  it("when the number is nowhere on the cited page the clinician decides, as before", () => {
    const f = blocking((m) => { m.derived[1].definition.all[1].any[0].all[2].value = 55; }).find((x) => x.params["number"] === 55)!;
    expect(f.decidedBy).toBe("clinician");
    expect(f.params["pageQuote"]).toBe("");
  });

  it("converts 60 months to 5 years visibly, never silently", () => {
    const f = run().find((x) => x.code === "NUMBER_UNIT_CONVERTED" && x.subjects[0]!.kind === "scope");
    expect(f).toBeDefined();
    expect(f!.params["derivation"]).toBe("60 months is the same as 5 years");
    expect(f!.decidedBy).toBe("clinician");
  });

  it("lists team entry limits in one finding, without grounding them", () => {
    const fs = run().filter((f) => f.code === "ENTRY_LIMIT_TEAM_CHOICE");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("info");
    expect(fs[0]!.subjects.map((s) => s.id)).toEqual(["age_months", "breaths_per_minute", "cough_days"]);
    expect(fs[0]!.message).toContain("0 to 120");
    expect(fs[0]!.message).toContain("10 to 120");
    expect(fs[0]!.message).toContain("0 to 365");
  });

  it("an entry limit that appears nowhere in the booklet is still not an ungrounded number", () => {
    expect(blocking((m) => { m.questions[0].constraint.max = 777; })).toEqual([]);
    const f = run((m) => { m.questions[0].constraint.max = 777; }).find((x) => x.code === "ENTRY_LIMIT_TEAM_CHOICE");
    expect(f!.message).toContain("0 to 777");
  });

  it("reports numbers of a team-owned rule without source as TEAM_VALUE when they are the covered age range", () => {
    expect(run().some((f) => f.code === "TEAM_VALUE")).toBe(false); // the final model's rule reads a calculated value that cites the booklet
    const t = run(teamAgeRule).find((f) => f.code === "TEAM_VALUE" && f.subjects.some((s) => s.id === "R2"))!;
    expect(t.severity).toBe("info");
    expect(t.message).toContain("clinician");
  });

  it("red team 2 (M10): a team-owned rule with a cut-off of its own blocks until a clinician answers an open question naming it", () => {
    const fs = blocking((m) => { teamAgeRule(m); m.rules.find((x: any) => x.id === "R2").when.any[0].value = 3; });
    expect(fs.map((f) => f.code)).toEqual(["TEAM_THRESHOLD_UNCONFIRMED"]);
    expect(fs[0]!.subjects).toContainEqual({ kind: "rule", id: "R2" });
    expect(fs[0]!.message).toContain("3 months");
    expect(fs[0]!.message).toContain("clinician");
  });

  it("an item written by the clinician (origin clinician) with no quote is decided by the clinician: not ungrounded, not a team value, listed as CLINICIAN_VALUE", () => {
    const mut = (m: any) => { const d = m.derived.find((x: any) => x.id === "fast_breathing"); d.origin = "clinician"; delete d.source; };
    const fs = run(mut);
    expect(fs.some((f) => f.code === "TEAM_VALUE" && f.subjects.some((x) => x.id === "fast_breathing"))).toBe(false);
    expect(fs.filter((f) => f.code === "UNGROUNDED_NUMBER" && f.subjects.some((x) => x.id === "fast_breathing"))).toEqual([]);
    expect(fs.filter((f) => f.code === "CLINICIAN_VALUE" && f.subjects.some((x) => x.id === "fast_breathing"))).toHaveLength(1);
  });

  it("flags a changed number in a derived definition (50 -> 55)", () => {
    const fs = blocking((m) => { m.derived[1].definition.all[1].any[0].all[2].value = 55; });
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("UNGROUNDED_NUMBER");
    expect(f.params["number"]).toBe(55);
    expect(f.subjects).toContainEqual({ kind: "derived", id: "fast_breathing" });
    expect(f.params["page"]).toBe("8");
    expect(f.message).toContain("55");
    expect(f.message).toContain("page 8");
  });

  it("flags a wrong unit on the question (days instead of months)", () => {
    const fs = blocking((m) => { m.questions[0].unit = "days"; });
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.map((f) => f.code)).toContain("UNIT_MISMATCH");
    const f = fs.find((x) => x.code === "UNIT_MISMATCH")!;
    expect(f.params["textUnits"]).toContain("month");
  });

  it("flags a changed number in a rule condition that cites the booklet", () => {
    const fs = blocking((m) => { m.derived[2].definition.any[0].all[1].value = 21; });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.subjects).toContainEqual({ kind: "derived", id: "danger_sign" });
  });

  it("grounds a number in a rule that cites the booklet and flags it when changed", () => {
    expect(blocking((m) => { m.rules[4].when = { field: "breaths_per_minute", op: "at_least", value: 40 }; })).toEqual([]);
    const fs = blocking((m) => { m.rules[4].when = { field: "breaths_per_minute", op: "at_least", value: 41 }; });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.subjects).toContainEqual({ kind: "rule", id: "R5" });
  });

  it("flags a number in a question's shown_when against the question's source", () => {
    const fs = blocking((m) => { m.questions[2].shown_when = { field: "age_months", op: "at_least", value: 33 }; });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.subjects).toContainEqual({ kind: "question", id: "cough_days" });
  });

  it("flags scope ages that the cited page does not support", () => {
    const fs = blocking((m) => { m.scope.age_months_min = 3; }).filter((f) => f.code === "UNGROUNDED_NUMBER");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.subjects).toEqual([{ kind: "scope", id: "scope" }]);
  });

  it("flags changed dose and total quantities and dose age limits", () => {
    const dose = blocking((m) => { m.outcomes[2].actions[0].dose_by_age[0].dose = "3 tablets"; });
    expect(dose).toHaveLength(1);
    expect(dose[0]!.subjects[0]!.kind).toBe("action");
    expect(dose[0]!.params["number"]).toBe(3);
    const total = blocking((m) => { m.outcomes[4].actions[0].dose_by_age[0].total = "11 tablets"; });
    expect(total.map((f) => f.params["number"])).toContain(11);
    const age = blocking((m) => { m.outcomes[2].actions[0].dose_by_age[0].age_months_below = 11; });
    expect(age.map((f) => f.params["number"])).toContain(11);
  });

  it("flags follow-up days and the task window; null is missing, not a number", () => {
    const due = blocking((m) => { m.outcomes[4].follow_up.due_in_days = 4; });
    expect(due).toHaveLength(1);
    expect(due[0]!.subjects).toEqual([{ kind: "follow_up", id: "treat_fast_breathing_at_home" }]);
    const win = blocking((m) => { m.outcomes[4].follow_up.task_window_days_after_due = 11; });
    expect(win.map((f) => f.params["number"])).toEqual([11]);
    const nothing = run((m) => { m.outcomes[4].follow_up.due_in_days = null; });
    expect(nothing.filter((f) => f.subjects.some((s) => s.kind === "follow_up" && s.id === "treat_fast_breathing_at_home"))).toEqual([]);
  });

  it("uses all quotes cited by an item: a second source can ground the number", () => {
    const mutate = (m: any) => { m.derived[1].definition.all[1].any[0].all[2].value = 55; };
    expect(blocking(mutate)).toHaveLength(1);
    const fs = blocking((m) => {
      mutate(m);
      m.derived[1].source.push({ page: 8, quote: "In a child age 2 months up to 12 months, 55 breaths or more per minute (not in the booklet)" });
    });
    // the added quote itself carries the number, so the number is now backed by a cited quote
    expect(fs).toEqual([]);
  });

  it("turns an ungrounded number into a recorded deviation when the clinician approved it", () => {
    const fs = numberGrounding({
      ...realCtx((m) => { m.derived[1].definition.all[1].any[0].all[2].value = 55; }),
      approvedDeviations: [{ subject: "fast_breathing", number: 55, by: "Dr Test", note: "local protocol" }],
    });
    const d = fs.find((f) => f.code === "GUIDELINE_DEVIATION")!;
    expect(d.severity).toBe("info");
    expect(fs.filter((f) => f.code === "UNGROUNDED_NUMBER" && f.params["number"] === 55)).toEqual([]);
  });

  it("reports a missing document once and does not guess", () => {
    const fs = numberGrounding({ model: realCtx().model });
    expect(fs.filter((f) => f.code === "SOURCE_DOCUMENT_MISSING")).toHaveLength(1);
    expect(fs.map((f) => f.code)).not.toContain("UNGROUNDED_NUMBER");
  });

  it("gives the same result with a matching file hash (the hash does not matter here)", () => {
    expect(numberGrounding(matchedCtx()).map((f) => f.id)).toEqual(run().map((f) => f.id));
  });

  it("is deterministic", () => {
    const m = (x: any) => { x.derived[1].definition.all[1].any[0].all[2].value = 55; };
    expect(codes(m)).toEqual(codes(m));
  });
});

describe("numbersInText", () => {
  it("reads quantities with units, decimals and fractions", () => {
    expect(numbersInText("1 tablet")).toEqual([{ value: 1, unit: "tablet" }]);
    expect(numbersInText("10 tablets")).toEqual([{ value: 10, unit: "tablets" }]);
    expect(numbersInText("1/2 tablet")).toEqual([{ value: 0.5, unit: "tablet" }]);
    expect(numbersInText("2.5 ml")).toEqual([{ value: 2.5, unit: "ml" }]);
    // red team 2 (M39): a dose in words is a number too, but only with a unit right after it
    expect(numbersInText("one tablet")).toEqual([{ value: 1, unit: "tablet" }]);
    expect(numbersInText("one or both")).toEqual([]);
    expect(numbersInText("(Go to page 10.)")).toEqual([]);
  });
});
