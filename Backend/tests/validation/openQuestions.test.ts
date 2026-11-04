import { describe, expect, it } from "vitest";
import { openQuestions } from "../../src/validation/checks/openQuestions.js";
import { matchedCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void) => openQuestions(matchedCtx(mutate));

describe("openQuestions on v1.json", () => {
  it("blocks once per open question, routed to the person named in the question", () => {
    const fs = run();
    expect(fs.map((f) => f.code)).toEqual(Array(6).fill("OPEN_QUESTION"));
    expect(fs.map((f) => f.subjects[0]!.id)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    for (const f of fs) {
      expect(f.severity).toBe("blocking");
      expect(f.audience).toEqual([f.params["route"]]);
      expect(f.decidedBy).toBe(f.params["route"]);
    }
    expect(fs.find((f) => f.subjects[0]!.id === "Q5")!.decidedBy).toBe("program_officer");
    expect(fs.find((f) => f.subjects[0]!.id === "Q1")!.decidedBy).toBe("clinician");
  });
  it("puts the question text, the page and the quote in the message", () => {
    const q1 = run().find((f) => f.subjects[0]!.id === "Q1")!;
    expect(q1.message).toContain("exactly 12 months");
    expect(q1.message).toContain("page 8");
    expect(q1.message).toContain("40 breaths or more per minute");
    expect(q1.message).toContain("clinician");
    const q5 = run().find((f) => f.subjects[0]!.id === "Q5")!;
    expect(q5.message).toContain("program officer");
  });
  it("a resolved question with a resolution text raises nothing", () => {
    const fs = run((m) => { m.open_questions[0].status = "resolved"; m.open_questions[0].resolution = "Dr Test: 12 months uses 40."; });
    expect(fs.map((f) => f.subjects[0]!.id)).toEqual(["Q2", "Q3", "Q4", "Q5", "Q6"]);
  });
  it("a resolved question without a resolution text is a warning, not a pass", () => {
    const fs = run((m) => { m.open_questions[0].status = "resolved"; });
    const w = fs.find((f) => f.code === "OPEN_QUESTION_NO_RESOLUTION")!;
    expect(w.severity).toBe("warning");
    expect(w.subjects[0]!.id).toBe("Q1");
    expect(w.decidedBy).toBe("clinician");
    const blank = run((m) => { m.open_questions[0].status = "resolved"; m.open_questions[0].resolution = "   "; });
    expect(blank.some((f) => f.code === "OPEN_QUESTION_NO_RESOLUTION")).toBe(true);
  });
  it("no open questions, no findings", () => {
    expect(run((m) => { m.open_questions = []; })).toEqual([]);
  });
});
