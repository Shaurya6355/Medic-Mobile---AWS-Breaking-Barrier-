import { z } from "zod";

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
