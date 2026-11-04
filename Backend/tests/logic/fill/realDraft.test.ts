import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DraftSchema } from "../../../src/logic/fill/draftSchema.js";
import { resolveDraft } from "../../../src/logic/fill/resolve.js";
import { enumerateAnswers, evaluate, parseModel, type Model } from "../../../src/logic/index.js";
import { ExtractionOutput } from "../../../src/steps/extractionSchema.js";
import { runChecks } from "../../../src/validation/runChecks.js";
import { realDocument, realExtraction, rawExtraction } from "../../validation/helpers.js";

/** The hand-written draft for the REAL extraction of the public WHO/UNICEF cough booklet, resolved by code. */
const backend = path.resolve(import.meta.dirname, "..", "..", "..");
const draft = DraftSchema.parse(JSON.parse(readFileSync(path.join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8")));
const doc = realDocument();
/** The team's FINAL logic model, read directly from the repo. */
const finalModel = (): Model => {
  const p = parseModel(JSON.parse(readFileSync(path.join(backend, "tests", "fixtures", "logic", "v1.json"), "utf8")));
  if (!p.ok) throw new Error(p.issues.join("\n"));
  return p.value;
};

function resolved(): Model {
  const r = resolveDraft(draft, ExtractionOutput.parse(rawExtraction()), {
    pathwayId: "cough_fast_breathing",
    createdAt: "2026-11-04T10:00:00Z",
    guideline: { title: "Caring for the sick child in the community: Chart booklet", publisher: "WHO and UNICEF", edition: "July 2014", fileSha256: doc.docSha256 },
  });
  if (!r.ok) throw new Error(r.problems.join("\n"));
  const p = parseModel(r.model);
  if (!p.ok) throw new Error(p.issues.join("\n"));
  return p.value;
}

describe("the real draft resolved against the real extraction", () => {
  const model = resolved();

  it("passes parseModel and runChecks without schema or reference errors", () => {
    const res = runChecks({ model, document: doc, extraction: realExtraction() });
    expect(res.findings.filter((f) => f.check === "schemaReferences")).toEqual([]);
    expect(res.findings.filter((f) => f.code === "CHECK_CRASHED")).toEqual([]);
    // Every quote is found in the booklet, every number is in its quote, no danger sign is dropped silently.
    for (const code of ["HALLUCINATED_CITATION", "UNGROUNDED_NUMBER", "DANGER_SIGN_NOT_MODELLED", "SEVERITY_INVERSION", "GUIDELINE_FILE_MISMATCH"]) {
      expect(res.findings.filter((f) => f.code === code)).toEqual([]);
    }
    expect(res.claim).toBe("PROVEN");
    // Content findings remain (open questions); that is expected and is the checks' job.
    expect(res.findings.some((f) => f.code === "OPEN_QUESTION")).toBe(true);
  });

  it("has the same questions, derived definitions, outcomes, rule table and open questions as the final model", () => {
    const ref = finalModel();
    expect(model.meta.created_by).toBe("ai_draft");
    expect(model.questions.map((q) => [q.id, q.answer_type, q.shown_when])).toEqual(ref.questions.map((q) => [q.id, q.answer_type, q.shown_when]));
    expect(model.derived.map((d) => [d.id, d.definition])).toEqual(ref.derived.map((d) => [d.id, d.definition]));
    expect(model.outcomes.map((o) => [o.id, o.severity])).toEqual(ref.outcomes.map((o) => [o.id, o.severity]));
    expect(model.rules.map((r) => [r.id, r.priority, r.when, r.outcome])).toEqual(ref.rules.map((r) => [r.id, r.priority, r.when, r.outcome]));
    expect(model.scope).toMatchObject({ age_months_min: ref.scope.age_months_min, age_months_below: ref.scope.age_months_below });
    const q2 = model.open_questions.find((q) => q.affects.includes("R1"));
    expect(q2?.route_to).toBe("clinician");
    expect(q2?.affects).toEqual(["R1", "R2", "refer_urgent_outside_age_range", "refer_outside_age_range"]);
    expect(q2?.question).toContain("urgently if they have a danger sign (R1) and routinely otherwise (R2), with no medicine. Is that right?");
  });

  it("gives the same result as the final model for every combination of answers", () => {
    const ref = finalModel();
    const grid = enumerateAnswers(model);
    expect(grid.exact).toBe(true);
    const differ = grid.points.filter((a) => evaluate(model, a).outcome !== evaluate(ref, a).outcome);
    expect(differ).toEqual([]);
    expect(grid.points.length).toBeGreaterThan(100);
  });

  it("keeps the urgent wording out of the routine out-of-range outcome", () => {
    const urgent = model.outcomes.find((o) => o.id === "refer_urgent_outside_age_range")!;
    const routine = model.outcomes.find((o) => o.id === "refer_outside_age_range")!;
    const hits = (o: typeof urgent) => o.actions.filter((a) => /urgent/i.test(a.text) || (a.source ?? []).some((s) => /urgent/i.test(s.quote)));
    expect(hits(urgent).length).toBeGreaterThan(0);
    expect(hits(routine)).toEqual([]);
    expect(routine.actions.length).toBeGreaterThan(0);
  });

  it("turns the unclear item into an open question with its quote", () => {
    const q = model.open_questions.find((x) => x.source?.some((s) => s.quote.includes("see\npage 10")));
    expect(q?.route_to).toBe("program_officer");
  });
});
