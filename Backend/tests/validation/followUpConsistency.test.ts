import { describe, expect, it } from "vitest";
import { followUpConsistency } from "../../src/validation/checks/followUpConsistency.js";
import { JARGON_RE, matchedCtx, realExtraction } from "./helpers.js";

const run = (mutate?: (m: any) => void) => followUpConsistency(matchedCtx(mutate));
const codes = (mutate?: (m: any) => void) => run(mutate).map((f) => f.code);
const idx = (id: string) => (m: any) => m.outcomes.findIndex((o: any) => o.id === id);

describe("followUpConsistency", () => {
  it("v1.json: on-return follow-ups that also carry a number of days are noted for the clinician; nothing blocks", () => {
    const fs = run();
    expect(fs.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(fs.map((f) => f.code)).toEqual(["FOLLOWUP_RETURN_DAYS_IGNORED", "FOLLOWUP_RETURN_DAYS_IGNORED"]);
    expect(fs.map((f) => f.subjects[0]!.id).sort()).toEqual(["refer_urgent", "refer_urgent_with_antibiotic"]);
    expect(fs[0]!.severity).toBe("info");
    expect(fs[0]!.decidedBy).toBe("clinician");
    expect(fs[0]!.message).toContain("7 days");
  });
  it("a referral outcome with no follow-up at all blocks, for the clinician", () => {
    const fs = run((m) => { m.outcomes[idx("refer_urgent")(m)].follow_up = null; });
    const f = fs.find((x) => x.code === "FOLLOWUP_MISSING_OUTCOME")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "outcome", id: "refer_urgent" }]);
    expect(f.message).toContain("Danger sign: refer urgently");
  });
  it("a referral is an outcome whose title or any action text contains refer, in any case", () => {
    expect(codes((m) => { const o = m.outcomes[idx("no_cough")(m)]; o.title = "REFERRED later"; })).toContain("FOLLOWUP_MISSING_OUTCOME");
    expect(codes((m) => { const o = m.outcomes[idx("cough_no_fast_breathing")(m)]; o.actions[0].text = "Refer if worse."; })).toContain("FOLLOWUP_MISSING_OUTCOME");
    expect(codes()).not.toContain("FOLLOWUP_MISSING_OUTCOME");
  });
  it("a non-referral outcome without follow-up is fine when nothing it cites or says asks for one", () => {
    expect(codes((m) => { m.outcomes[idx("cough_no_fast_breathing")(m)].follow_up = null; })).toEqual(["FOLLOWUP_RETURN_DAYS_IGNORED", "FOLLOWUP_RETURN_DAYS_IGNORED"]);
  });
  it("a scheduled follow-up with negative days blocks", () => {
    const fs = run((m) => { m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up.due_in_days = -2; });
    const f = fs.find((x) => x.code === "FOLLOWUP_INVALID_DAYS")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toContain("-2");
  });
  it("a negative task window blocks; a missing (null) window or day count is left to the compile check", () => {
    expect(codes((m) => { m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up.task_window_days_after_due = -1; })).toContain("FOLLOWUP_INVALID_DAYS");
    const nulls = run((m) => { const f = m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up; f.due_in_days = null; f.task_window_days_after_due = null; });
    expect(nulls.map((f) => f.code)).not.toContain("FOLLOWUP_INVALID_DAYS");
    expect(nulls.length).toBe(2);
  });
  it("an on-return follow-up without days raises nothing", () => {
    expect(codes((m) => { m.outcomes[idx("refer_urgent")(m)].follow_up.due_in_days = null; })).toEqual(["FOLLOWUP_RETURN_DAYS_IGNORED"]);
  });
});

describe("followUpConsistency: red team 1", () => {
  it("a result a danger sign leads to is a referral whatever its wording, so it needs a follow-up (M33)", () => {
    const fs = followUpConsistency({ ...matchedCtx((m) => {
      const o = m.outcomes[idx("refer_urgent")(m)];
      o.title = "Danger sign: advise fluids at home";
      o.actions = structuredClone(m.outcomes[idx("cough_no_fast_breathing")(m)].actions);
      o.follow_up = null;
    }), extraction: realExtraction() });
    expect(fs.map((f) => f.code)).toContain("FOLLOWUP_MISSING_OUTCOME");
    // without the extraction, the calculated value named as a danger sign is enough to know
    expect(codes((m) => {
      const o = m.outcomes[idx("refer_urgent")(m)];
      o.title = "Danger sign: advise fluids at home";
      o.actions = structuredClone(m.outcomes[idx("cough_no_fast_breathing")(m)].actions);
      o.follow_up = null;
    })).toContain("FOLLOWUP_MISSING_OUTCOME");
  });
  it("a result whose title or cited passage says to follow up must have a follow-up (M43)", () => {
    const fs = run((m) => { m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up = null; });
    const f = fs.find((x) => x.code === "FOLLOWUP_REQUIRED_BY_SOURCE")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "outcome", id: "treat_fast_breathing_at_home" }]);
    expect(f.message).toContain("follow up in 3 days");
    const viaQuote = run((m) => { m.outcomes[idx("cough_no_fast_breathing")(m)].actions[0].source = [{ page: 9, quote: "Follow up child in 3 days." }]; });
    expect(viaQuote.find((x) => x.code === "FOLLOWUP_REQUIRED_BY_SOURCE")!.message).toContain("page 9");
  });
  it("a follow-up after a fixed number of days turned into a follow-up on return blocks (M45)", () => {
    const fs = run((m) => { const f = m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up; f.kind = "on_return"; f.due_in_days = null; });
    const f = fs.find((x) => x.code === "FOLLOWUP_KIND_MISMATCH")!;
    expect(f.severity).toBe("blocking");
    expect(f.message).toContain("Follow up child in 3 days");
    // "on return at least once a week" is not a fixed number of days
    expect(codes()).not.toContain("FOLLOWUP_KIND_MISMATCH");
  });
  it("a scheduled follow-up due after 0 days blocks (M47)", () => {
    const fs = run((m) => { m.outcomes[idx("treat_fast_breathing_at_home")(m)].follow_up.due_in_days = 0; });
    const f = fs.find((x) => x.code === "FOLLOWUP_DUE_SAME_DAY")!;
    expect(f.severity).toBe("blocking");
    expect(f.message).toContain("0 days");
    expect(f.message).not.toMatch(JARGON_RE);
  });
});
