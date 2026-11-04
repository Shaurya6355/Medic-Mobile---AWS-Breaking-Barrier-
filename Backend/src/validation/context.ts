import { z } from "zod";
import { parseModel } from "../logic/schema.js";
import type { CrossCheckInput } from "./finding.js";

/**
 * Optional inputs of the checks, each validated on the way in: the extraction record (what the
 * guideline reader found in the booklet) and the golden cases (children whose result the clinician knows).
 */

const Src = z.looseObject({ block_id: z.string(), pdf_page: z.number().int().min(0), quote: z.string() });

const ExtractionSchema = z.looseObject({
  danger_signs: z.array(
    z.looseObject({
      id: z.string().min(1),
      text: z.string().min(1),
      cough_relevant: z.boolean(),
      src: z.array(Src),
    }),
  ),
  nodes: z.array(
    z.looseObject({
      id: z.string().min(1),
      kind: z.string().optional(),
      text: z.string().optional(),
      out_of_scope: z.boolean().optional(),
      src: z.array(Src),
    }),
  ),
  actions: z.array(z.looseObject({ id: z.string().min(1), src: z.array(Src) })).default([]),
  followups: z.array(z.looseObject({ id: z.string().min(1), src: z.array(Src) })).default([]),
});

export type Extraction = z.output<typeof ExtractionSchema>;
export type ExtractionSource = z.output<typeof Src>;

/** Validates the parts of extraction/extraction_output.json the checks read. Throws on bad input. */
export function loadExtraction(json: unknown): Extraction {
  return ExtractionSchema.parse(json);
}

const GoldenCaseSchema = z
  .looseObject({
    id: z.string().min(1),
    description: z.string(),
    answers: z.record(z.string(), z.union([z.number(), z.boolean()])),
    expected_outcome: z.string().min(1),
    expected_rule: z.string().min(1).optional(),
    note: z.string().optional(),
  });

export type GoldenCase = z.output<typeof GoldenCaseSchema>;

/** Validates golden cases {id, description, answers, expected_outcome, expected_rule?, note?}. Throws on bad input or a repeated id. */
export function loadGoldenCases(json: unknown): GoldenCase[] {
  const cases = z.array(GoldenCaseSchema).parse(json);
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate golden case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

/**
 * One saved version of the logic model as the open-question check sees it (DEC-020): the model, who
 * saved it and in which role. The sign-off service passes the whole chain from version 1 up to the one
 * being checked (oldest first, the checked version last) as `history` next to the CheckContext.
 * AUTH SEAM (DEC-015): author and authorRole come from the save request until Cognito is built.
 */
export type VersionHistoryEntry = {
  n: number;
  model: import("../logic/schema.js").Model;
  /** The person who saved the version (Version.author). */
  author: string;
  /** The role they saved it in; absent when not recorded. */
  authorRole?: "program_officer" | "clinician";
};

/** CheckContext plus the version chain; runChecks passes the context through to every check unchanged. */
export type HistoryContext = { history?: readonly VersionHistoryEntry[] };

/**
 * True when a written answer or change note says something: at least 15 characters and three words
 * of two or more letters. "x", "ok", "accepted" or a run of one letter are not answers.
 */
export function isMeaningfulText(text: string | undefined): boolean {
  if (text === undefined) return false;
  const t = text.trim();
  if (t.length < 15) return false;
  const words = (t.match(/\p{L}{2,}/gu) ?? []).filter((w) => !/^(\p{L})\1+$/u.test(w));
  return new Set(words.map((w) => w.toLowerCase())).size >= 3;
}

/**
 * Reads the second, independent draft (a logic model as JSON). A draft that does not parse is not an error: it becomes
 * { invalid: [...] } so the cross-check can say plainly that it was not compared.
 */
export function loadCrossCheck(json: unknown): CrossCheckInput {
  const r = parseModel(json);
  return r.ok ? { model: r.value } : { invalid: r.issues.slice(0, 20) };
}
