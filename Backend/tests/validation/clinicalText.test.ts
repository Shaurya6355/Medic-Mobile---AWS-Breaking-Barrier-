import { describe, expect, it } from "vitest";
import { clinicalText } from "../../src/validation/checks/clinicalText.js";
import { matchedCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void) => clinicalText(matchedCtx(mutate));
const codes = (mutate?: (m: any) => void) => run(mutate).map((f) => f.code);
const idx = (id: string) => (m: any) => m.outcomes.findIndex((o: any) => o.id === id);

describe("clinicalText", () => {
  it("v1.json: only the team's own wording is listed for the clinician to confirm", () => {
    // red team 2: AI-worded labels and titles are listed too, as one warning (see clinicalText.redteam2.test.ts)
    expect(run().filter((f) => f.code === "AI_WORDED_TEXT").map((f) => f.severity)).toEqual(["warning"]);
    const fs = run().filter((f) => f.code !== "AI_WORDED_TEXT");
    expect(fs.map((f) => f.code)).toEqual(["TEAM_TEXT_TO_CONFIRM", "TEAM_TEXT_TO_CONFIRM"]);
    expect(fs.map((f) => f.subjects[0]!.id).sort()).toEqual(["cough_no_fast_breathing", "no_cough"]);
    for (const f of fs) {
      expect(f.severity).toBe("info");
      expect(f.decidedBy).toBe("clinician");
      expect(f.audience[0]).toBe("clinician");
    }
    expect(fs.find((f) => f.subjects[0]!.id === "no_cough")!.message).toContain("Continue with the other parts");
  });
  it("an outcome whose actions have no text blocks", () => {
    const fs = run((m) => { m.outcomes[idx("no_cough")(m)].actions = [{ text: "   ", origin: "team" }]; });
    const f = fs.find((x) => x.code === "CLINICAL_TEXT_MISSING")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "outcome", id: "no_cough" }]);
    expect(codes((m) => { m.outcomes[idx("no_cough")(m)].actions = []; })).toContain("CLINICAL_TEXT_MISSING");
  });
  it("one action with text is enough for that check", () => {
    expect(codes((m) => { m.outcomes[idx("no_cough")(m)].actions.push({ text: " ", origin: "team" }); })).not.toContain("CLINICAL_TEXT_MISSING");
  });
  it("a referral outcome whose only wording is the team's own is unsourced and blocks", () => {
    const fs = run((m) => { const o = m.outcomes[idx("refer_urgent")(m)]; o.actions = [{ text: "Send the child to the clinic.", origin: "team" }]; });
    const f = fs.find((x) => x.code === "CLINICAL_TEXT_UNSOURCED")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toContain("Danger sign: refer urgently");
  });
  it("a guideline action without any source also counts as unsourced", () => {
    expect(codes((m) => { const o = m.outcomes[idx("refer_urgent")(m)]; o.actions = [{ text: "Send the child to the clinic.", origin: "guideline", source: [] }]; })).toContain("CLINICAL_TEXT_UNSOURCED");
  });
  it("a referral outcome with one sourced guideline action is fine even next to a team action", () => {
    const fs = run((m) => { m.outcomes[idx("refer_urgent")(m)].actions.push({ text: "Offer a drink.", origin: "team" }); });
    expect(fs.map((f) => f.code)).not.toContain("CLINICAL_TEXT_UNSOURCED");
    expect(fs.filter((f) => f.code === "TEAM_TEXT_TO_CONFIRM").map((f) => f.subjects[0]!.id)).toContain("refer_urgent");
  });
  it("a non-referral outcome may be unsourced (only team wording to confirm)", () => {
    expect(codes()).not.toContain("CLINICAL_TEXT_UNSOURCED");
  });
});
