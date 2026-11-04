import { describe, expect, it } from "vitest";
import { openQuestions } from "../../src/validation/checks/openQuestions.js";
import type { Model } from "../../src/logic/index.js";
import type { VersionHistoryEntry } from "../../src/validation/context.js";
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
  it("a resolved question without a resolution text blocks for the person it is routed to (DEC-020)", () => {
    const fs = run((m) => { m.open_questions[0].status = "resolved"; });
    const w = fs.find((f) => f.code === "OPEN_QUESTION_NO_RESOLUTION")!;
    expect(w.severity).toBe("blocking");
    expect(w.subjects[0]!.id).toBe("Q1");
    expect(w.decidedBy).toBe("clinician");
    const blank = run((m) => { m.open_questions[0].status = "resolved"; m.open_questions[0].resolution = "   "; });
    expect(blank.some((f) => f.code === "OPEN_QUESTION_NO_RESOLUTION")).toBe(true);
  });
  it("no open questions, no findings", () => {
    expect(run((m) => { m.open_questions = []; })).toEqual([]);
  });
});

const ANSWER = "Dr Test: a child of exactly 12 months uses the 40 breaths cut-off.";
const resolve = (m: Model, id: string, resolution = ANSWER): Model => {
  const c = structuredClone(m);
  const q = c.open_questions.find((x) => x.id === id)!;
  q.status = "resolved";
  q.resolution = resolution;
  return c;
};
const entry = (n: number, model: Model, authorRole?: "program_officer" | "clinician", author = "person-" + n): VersionHistoryEntry => ({
  n,
  model,
  author,
  ...(authorRole !== undefined ? { authorRole } : {}),
});
/** openQuestions over the last entry of the chain, with the whole chain as history. */
const chain = (...entries: VersionHistoryEntry[]) => {
  const last = entries[entries.length - 1]!;
  return openQuestions({ ...matchedCtx(), model: last.model, history: entries } as never);
};
const codes = (fs: { code: string; subjects: { id: string }[] }[], id: string) => fs.filter((f) => f.subjects[0]!.id === id).map((f) => f.code);

describe("openQuestions: answers must be real (DEC-020)", () => {
  it("a trivial answer (\"x\", \"ok\", one word) blocks", () => {
    for (const r of ["x", "ok", "yes", "accepted", "...", "aaaaaaaaaaaaaaaaaaaa"]) {
      const fs = run((m) => { m.open_questions[0].status = "resolved"; m.open_questions[0].resolution = r; });
      const f = fs.find((x) => x.subjects[0]!.id === "Q1")!;
      expect(f.code, r).toBe("OPEN_QUESTION_TRIVIAL_RESOLUTION");
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("clinician");
    }
  });
});

describe("openQuestions: who answered, against the earlier versions (DEC-020)", () => {
  const root = (): Model => matchedCtx().model;

  it("a question answered by the role it is routed to, with a change note, passes", () => {
    const v1 = root();
    const v2 = resolve(v1, "Q1");
    v2.meta.change_note = "Clinician answered Q1 after checking the booklet.";
    expect(codes(chain(entry(1, v1), entry(2, v2, "clinician", "dr-test")), "Q1")).toEqual([]);
  });

  it("a clinician question answered in a version saved by the program officer blocks for the clinician", () => {
    const v1 = root();
    const v2 = resolve(v1, "Q1");
    v2.meta.change_note = "Officer settled the open questions.";
    const fs = chain(entry(1, v1), entry(2, v2, "program_officer"));
    const f = fs.find((x) => x.code === "OPEN_QUESTION_WRONG_RESOLVER")!;
    expect(f.subjects[0]!.id).toBe("Q1");
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
  });

  it("an answer saved without a recorded role blocks", () => {
    const v1 = root();
    const v2 = resolve(v1, "Q5");
    v2.meta.change_note = "Answered Q5 about the follow-up window.";
    expect(codes(chain(entry(1, v1), entry(2, v2)), "Q5")).toEqual(["OPEN_QUESTION_WRONG_RESOLVER"]);
  });

  it("a later version cannot launder a wrong answer: the version that first wrote it decides", () => {
    const v1 = root();
    const v2 = resolve(v1, "Q1");
    v2.meta.change_note = "Officer settled the open questions.";
    const v3 = structuredClone(v2);
    v3.meta.change_note = "Clinician fixed a typo elsewhere.";
    expect(codes(chain(entry(1, v1), entry(2, v2, "program_officer"), entry(3, v3, "clinician")), "Q1")).toEqual(["OPEN_QUESTION_WRONG_RESOLVER"]);
    // Rewriting the answer as the clinician settles it.
    const v4 = resolve(v3, "Q1", "Dr Test confirms: exactly 12 months uses the 40 breaths cut-off.");
    v4.meta.change_note = "Clinician answered Q1 in their own words.";
    expect(codes(chain(entry(1, v1), entry(2, v2, "program_officer"), entry(3, v3, "clinician"), entry(4, v4, "clinician")), "Q1")).toEqual([]);
  });

  it("a clinician answer needs the clinician's name and a change note on the version", () => {
    const v1 = root();
    const v2 = resolve(v1, "Q1");
    v2.meta.change_note = "";
    expect(codes(chain(entry(1, v1), entry(2, v2, "clinician")), "Q1")).toEqual(["OPEN_QUESTION_CLINICIAN_NOT_RECORDED"]);
    v2.meta.change_note = "Clinician answered Q1 after checking the booklet.";
    expect(codes(chain(entry(1, v1), entry(2, v2, "clinician", " ")), "Q1")).toEqual(["OPEN_QUESTION_CLINICIAN_NOT_RECORDED"]);
  });

  it("a question removed in a later version blocks, and stays blocking in every version after it", () => {
    const v1 = root();
    const v2 = structuredClone(v1);
    v2.open_questions = v2.open_questions.filter((q) => q.id !== "Q1");
    v2.meta.change_note = "Removed a question.";
    const v3 = structuredClone(v2);
    for (const fs of [chain(entry(1, v1), entry(2, v2, "program_officer")), chain(entry(1, v1), entry(2, v2, "program_officer"), entry(3, v3, "clinician"))]) {
      const f = fs.find((x) => x.code === "OPEN_QUESTION_REMOVED")!;
      expect(f.subjects[0]!.id).toBe("Q1");
      expect(f.severity).toBe("blocking");
      expect(f.decidedBy).toBe("clinician");
    }
  });

  it("a question routed elsewhere after it was raised blocks for the original person", () => {
    const v1 = root();
    const v2 = structuredClone(v1);
    v2.open_questions.find((q) => q.id === "Q1")!.route_to = "program_officer";
    v2.meta.change_note = "Rerouted Q1.";
    const fs = chain(entry(1, v1), entry(2, v2, "program_officer"));
    const f = fs.find((x) => x.code === "OPEN_QUESTION_REROUTED")!;
    expect(f.decidedBy).toBe("clinician");
  });

  it("without history only the content rules apply (the first version comes from fill_logic with every question open)", () => {
    const v1 = resolve(root(), "Q1");
    expect(codes(chain(entry(1, v1)), "Q1")).toEqual([]);
  });
});
