import { describe, expect, it } from "vitest";
import { numberGrounding } from "../../src/validation/checks/numberGrounding.js";
import { realDraftCtx } from "./realDraftModel.js";

const D = (m: any, id: string) => m.derived.find((x: any) => x.id === id);
const O = (m: any, id: string) => m.outcomes.find((x: any) => x.id === id);
const Q = (m: any, id: string) => m.questions.find((x: any) => x.id === id);
const FB = (m: any) => D(m, "fast_breathing").definition.all[1].any;
const DS = (m: any) => D(m, "danger_sign").definition.any;
const homeDose = (m: any) => O(m, "treat_fast_breathing_at_home").actions.find((a: any) => a.dose_by_age).dose_by_age;
const run = (mut?: (m: any) => void) => numberGrounding(realDraftCtx(mut));
const blocking = (mut?: (m: any) => void) => run(mut).filter((f) => f.severity === "blocking");
const codes = (mut?: (m: any) => void) => blocking(mut).map((f) => f.code);

describe("numberGrounding on the resolved real draft (red team 2)", () => {
  it("baseline has no blocking number finding", () => {
    expect(blocking()).toEqual([]);
  });
  it("M02: swapping 50 and 40 between the age bands is blocking (each cut-off must sit with its own age band in one passage)", () => {
    const fs = blocking((m) => { FB(m)[0].all[2].value = 40; FB(m)[1].all[2].value = 50; });
    expect(fs.map((f) => f.code)).toContain("NUMBER_PAIRING_MISMATCH");
    const f = fs.find((x) => x.code === "NUMBER_PAIRING_MISMATCH")!;
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toMatch(/same passage|together/);
  });
  it("M36/M37: doses or totals swapped between age bands are blocking", () => {
    expect(codes((m) => { const d = homeDose(m); [d[0].dose, d[1].dose] = [d[1].dose, d[0].dose]; })).toContain("NUMBER_PAIRING_MISMATCH");
    expect(codes((m) => { const d = homeDose(m); [d[0].total, d[1].total] = [d[1].total, d[0].total]; })).toContain("NUMBER_PAIRING_MISMATCH");
  });
  it("M39: a dose in words is read as a number: 'two tablets' is grounded, 'three tablets' is not", () => {
    expect(codes((m) => { homeDose(m)[1].dose = "two tablets"; })).toEqual([]);
    expect(codes((m) => { homeDose(m)[1].dose = "three tablets"; })).toContain("UNGROUNDED_NUMBER");
  });
  it("M09/M09b: a number taken from a quote about something else (fever, not cough) is blocking", () => {
    expect(codes((m) => { DS(m)[0].all[1].value = 7; D(m, "danger_sign").source.push({ page: 6, quote: "Fever for last 7 days or more" }); })).toContain("NUMBER_CONTEXT_MISMATCH");
    expect(codes((m) => { DS(m)[0].all[1].value = 7; D(m, "danger_sign").source = [{ page: 6, quote: "Fever for last 7 days or more" }]; })).toContain("NUMBER_CONTEXT_MISMATCH");
  });
  it("M84: follow-up days borrowed from a dosing passage are blocking", () => {
    expect(codes((m) => { const f = O(m, "treat_fast_breathing_at_home").follow_up; f.due_in_days = 5; f.source.push({ page: 9, quote: "Give twice daily for 5 days:" }); })).toContain("NUMBER_CONTEXT_MISMATCH");
  });
  it("M47: a follow-up after 0 days is checked like any number", () => {
    expect(codes((m) => { O(m, "treat_fast_breathing_at_home").follow_up.due_in_days = 0; })).toContain("UNGROUNDED_NUMBER");
  });
  it("M10: a team-origin calculated value with cut-offs and no source blocks until a clinician-answered open question names it", () => {
    const mut = (m: any) => { const d = D(m, "fast_breathing"); d.origin = "team"; delete d.source; FB(m)[0].all[2].value = 60; FB(m)[1].all[2].value = 55; };
    const f = blocking(mut).find((x) => x.code === "TEAM_THRESHOLD_UNCONFIRMED")!;
    expect(f).toBeDefined();
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toContainEqual({ kind: "derived", id: "fast_breathing" });
    // a program-officer answer does not count; an open (unanswered) clinician question does not count
    const withOq = (status: string, route: string) => (m: any) => { mut(m); m.open_questions.push({ id: "QX", question: "Team cut-offs for fast breathing: 12 months, then 60 and 55 breaths per minute?", affects: ["fast_breathing"], route_to: route, status, ...(status === "resolved" ? { resolution: "Confirmed by Dr Test." } : {}) }); };
    expect(codes(withOq("resolved", "program_officer"))).toContain("TEAM_THRESHOLD_UNCONFIRMED");
    expect(codes(withOq("open", "clinician"))).toContain("TEAM_THRESHOLD_UNCONFIRMED");
    expect(codes(withOq("resolved", "clinician"))).not.toContain("TEAM_THRESHOLD_UNCONFIRMED");
    // the clinician's answer to the age-band question (which also names fast_breathing) does not confirm the team's numbers
    const bandOnly = (m: any) => { mut(m); for (const q of m.open_questions) { q.status = "resolved"; q.resolution = "Confirmed by Dr Test."; } };
    expect(codes(bandOnly)).toContain("TEAM_THRESHOLD_UNCONFIRMED");
  });
  it("the final model's out-of-age value is the guideline's own (quote on page 3), so no team value is left to confirm for it", () => {
    expect(run().filter((f) => f.code === "TEAM_VALUE")).toEqual([]);
  });
  it("a team rule that tests the age against the covered range itself (the first model's shape) stays a team value to confirm, not blocking", () => {
    const inline = (m: any) => { const r = m.rules.find((x: any) => x.id === "R2"); r.when = { any: [{ field: "age_months", op: "less_than", value: 2 }, { field: "age_months", op: "at_least", value: 60 }] }; delete r.source; r.origin = "team"; };
    expect(run(inline).filter((f) => f.code === "TEAM_VALUE").map((f) => f.subjects.map((x) => x.id))).toEqual([["age_months", "R2"]]);
    // but a team rule with its own cut-off (not the covered range) blocks
    expect(codes((m) => { inline(m); m.rules.find((x: any) => x.id === "R2").when.any[0].value = 3; })).toContain("TEAM_THRESHOLD_UNCONFIRMED");
  });
  it("a changed cut-off in the guideline's out-of-age value (below 3 instead of below 2) is an ungrounded number", () => {
    expect(codes((m) => { m.derived.find((d: any) => d.id === "outside_age_range").definition.any[0].value = 3; })).toContain("UNGROUNDED_NUMBER");
  });
  it("C2/D1/D2: numbers in labels and titles must be in a quote of that item", () => {
    expect(codes((m) => { Q(m, "breaths_per_minute").label = "Count the child's breaths in 30 seconds"; })).toContain("NUMBER_IN_TEXT_UNSUPPORTED");
    expect(codes((m) => { O(m, "treat_fast_breathing_at_home").title = "Give amoxicillin 6 tablets twice daily for 30 days"; })).toContain("NUMBER_IN_TEXT_UNSUPPORTED");
    expect(codes((m) => { D(m, "fast_breathing").label = "Fast breathing (30 breaths or more)"; })).toContain("NUMBER_IN_TEXT_UNSUPPORTED");
    expect(codes((m) => { O(m, "cough_no_fast_breathing").actions[0].text = "Return in 30 days. Give 6 amoxicillin tablets twice daily."; })).toContain("NUMBER_IN_TEXT_UNSUPPORTED");
    const f = blocking((m) => { O(m, "treat_fast_breathing_at_home").title = "Give amoxicillin 6 tablets twice daily"; }).find((x) => x.code === "NUMBER_IN_TEXT_UNSUPPORTED")!;
    expect(f.message).toContain("6");
    expect(f.decidedBy).toBe("clinician");
  });
  it("numbers in text that the item's quotes carry are fine (the real titles and labels)", () => {
    expect(codes((m) => { O(m, "treat_fast_breathing_at_home").title = "Fast breathing: follow up in 3 days"; })).toEqual([]);
  });
});
