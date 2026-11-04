import { readFileSync } from "node:fs";
import path from "node:path";
import { DraftSchema } from "../../src/logic/fill/draftSchema.js";
import { resolveDraft } from "../../src/logic/fill/resolve.js";
import { parseModel, type Model } from "../../src/logic/schema.js";
import { ExtractionOutput } from "../../src/steps/extractionSchema.js";
import type { CheckContext } from "../../src/validation/finding.js";
import { rawExtraction, realDocument, realExtraction } from "./helpers.js";

/** The real draft (tests/fixtures/fill/draft-cough.json) resolved against the real extraction, for red-team tests. */
export const rawDraft = (): any => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/fill/draft-cough.json"), "utf8"));

const doc = realDocument();

export function resolveReal(mutDraft?: (d: any) => void, mutEx?: (e: any) => void): { ok: true; model: Model } | { ok: false; problems: string[] } {
  const d = rawDraft();
  mutDraft?.(d);
  const e = rawExtraction();
  mutEx?.(e);
  const r = resolveDraft(DraftSchema.parse(d), ExtractionOutput.parse(e), {
    pathwayId: "cough_fast_breathing",
    createdAt: "2026-11-04T10:00:00Z",
    guideline: { title: "Caring for the sick child in the community: Chart booklet", publisher: "WHO and UNICEF", edition: "July 2014", fileSha256: doc.docSha256 },
  });
  if (!r.ok) return r;
  const p = parseModel(r.model);
  if (!p.ok) throw new Error(p.issues.join("\n"));
  return { ok: true, model: p.value };
}

/** The resolved real draft (optionally changed afterwards, as a hand edit would) with the real booklet and extraction. */
export function realDraftCtx(mutModel?: (m: any) => void, mutDraft?: (d: any) => void, mutEx?: (e: any) => void): CheckContext {
  const r = resolveReal(mutDraft, mutEx);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  const m = structuredClone(r.model) as any;
  mutModel?.(m);
  return { model: m as Model, document: doc, extraction: realExtraction(mutEx) };
}
