import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DraftSchema } from "../../../src/logic/fill/draftSchema.js";
import { resolveDraft } from "../../../src/logic/fill/resolve.js";
import { enumerateAnswers, evaluate, parseModel, type Model } from "../../../src/logic/index.js";
import { ExtractionOutput } from "../../../src/steps/extractionSchema.js";
import { runChecks } from "../../../src/validation/runChecks.js";
import { realDocument, realExtraction, rawExtraction } from "../../validation/helpers.js";
import { v1 } from "../helpers.js";

/** The hand-written draft for the REAL extraction of the public WHO/UNICEF cough booklet, resolved by code. */
const backend = path.resolve(import.meta.dirname, "..", "..", "..");
const draft = DraftSchema.parse(JSON.parse(readFileSync(path.join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8")));
const doc = realDocument();

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

  it("has the same questions, derived definitions and rule conditions as the hand-written v1.json", () => {
    const ref = v1();
    expect(model.questions.map((q) => [q.id, q.answer_type, q.shown_when])).toEqual(ref.questions.map((q) => [q.id, q.answer_type, q.shown_when]));
    for (const d of ref.derived) expect(model.derived.find((x) => x.id === d.id)?.definition).toEqual(d.definition);
    expect(model.rules.map((r) => r.when)).toEqual(ref.rules.map((r) => r.when));
    expect(model.scope).toMatchObject({ age_months_min: ref.scope.age_months_min, age_months_below: ref.scope.age_months_below });
  });

  it("gives the same result as v1.json for every combination of answers", () => {
    const ref = v1();
    const rename = (id: string): string => (id === "outside_age_range" ? "refer_outside_age_range" : id);
    const grid = enumerateAnswers(model);
    expect(grid.exact).toBe(true);
    const differ = grid.points.filter((a) => rename(evaluate(model, a).outcome) !== evaluate(ref, a).outcome);
    expect(differ).toEqual([]);
    expect(grid.points.length).toBeGreaterThan(100);
  });

  it("turns the unclear item into an open question with its quote", () => {
    const q = model.open_questions.find((x) => x.source?.some((s) => s.quote.includes("see\npage 10")));
    expect(q?.route_to).toBe("program_officer");
  });
});
