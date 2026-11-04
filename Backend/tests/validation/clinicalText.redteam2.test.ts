import { describe, expect, it } from "vitest";
import { clinicalText } from "../../src/validation/checks/clinicalText.js";
import { realDraftCtx } from "./realDraftModel.js";

const Q = (m: any, id: string) => m.questions.find((x: any) => x.id === id);
const O = (m: any, id: string) => m.outcomes.find((x: any) => x.id === id);
const run = (mut?: (m: any) => void, mutDraft?: (d: any) => void) => clinicalText(realDraftCtx(mut, mutDraft));
const blocking = (mut?: (m: any) => void, mutDraft?: (d: any) => void) => run(mut, mutDraft).filter((f) => f.severity === "blocking");

describe("clinicalText: wording shown to the health worker (red team 2)", () => {
  it("baseline: nothing blocks; AI-worded labels and titles are one warning for the clinician", () => {
    expect(blocking()).toEqual([]);
    const w = run().filter((f) => f.code === "AI_WORDED_TEXT");
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe("warning");
    expect(w[0]!.decidedBy).toBe("clinician");
    expect(w[0]!.audience[0]).toBe("clinician");
    expect(w[0]!.message).toContain("Does the child have a cough?");
    expect(w[0]!.subjects).toContainEqual({ kind: "question", id: "cough" });
    // action texts are the booklet's own words, so they are not listed
    expect(w[0]!.subjects.some((s) => s.kind === "action")).toBe(false);
  });
  it("C1: a label that drops the booklet's 'not' is blocking", () => {
    const f = blocking((m) => { Q(m, "not_able_to_drink_or_feed").label = "Is the child able to drink or feed?"; }).find((x) => x.code === "TEXT_NEGATION_MISMATCH")!;
    expect(f).toBeDefined();
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toEqual([{ kind: "question", id: "not_able_to_drink_or_feed" }]);
  });
  it("C3: a label that adds a 'not' and is about something else is blocking", () => {
    const codes = blocking((m) => { Q(m, "chest_indrawing").label = "Does the child NOT have HIV?"; }).map((f) => f.code);
    expect(codes).toContain("TEXT_NEGATION_MISMATCH");
    expect(codes).toContain("TEXT_OFF_TOPIC");
  });
  it("C8: a referral result titled 'No danger sign: treat at home' is blocking", () => {
    expect(blocking((m) => { O(m, "refer_urgent").title = "No danger sign: treat at home"; }).map((f) => f.code)).toContain("TEXT_NEGATION_MISMATCH");
  });
  it("D17: a question whose label shares no word with its booklet passage is blocking", () => {
    const fs = blocking(undefined, (d) => { d.questions.push({ id: "hiv", label: "Is the child HIV positive?", answer_type: "yes_no", node_id: "n_ref_transport" }); });
    expect(fs.map((f) => f.code)).toContain("TEXT_OFF_TOPIC");
  });
});
