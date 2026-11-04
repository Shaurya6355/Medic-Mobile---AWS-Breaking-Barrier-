import { readFileSync } from "node:fs";
import { parseModel, type Model } from "../../../src/logic/index.js";
import { ExtractionOutput } from "../../../src/steps/extractionSchema.js";
import type { RevisionComment } from "../../../src/revision/types.js";

export function loadModel(): Model {
  const r = parseModel(JSON.parse(readFileSync(new URL("../../fixtures/logic/v1.json", import.meta.url), "utf8")));
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.value;
}
export function loadExtraction(): ExtractionOutput {
  return ExtractionOutput.parse(JSON.parse(readFileSync(new URL("../../../extraction/extraction_output.json", import.meta.url), "utf8")));
}
export const comment = (itemRef: string, text = "Please check this."): RevisionComment => ({ itemRef, text, author: "po1", source: "comment", createdAt: 1 });
export const revision = { id: "rev1", fromVersion: 1, nowIso: "2026-11-04T10:00:00.000Z", instruction: "Fix the item." };
