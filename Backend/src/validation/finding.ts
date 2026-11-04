import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../logic/canonical.js";
import type { Model } from "../logic/schema.js";
import type { CompileSettings } from "../compiler/types.js";
import type { Extraction, GoldenCase } from "./context.js";
import { render } from "./messages.js";

export const Audience = z.enum(["program_officer", "clinician"]);
export type Audience = z.infer<typeof Audience>;

export const SubjectKind = z.enum([
  "question",
  "derived",
  "outcome",
  "action",
  "follow_up",
  "rule",
  "scope",
  "open_question",
  "document",
]);

const Scalar = z.union([z.string(), z.number().finite(), z.boolean()]);

export const FindingSchema = z
  .object({
    /** sha256 hex of the canonical {check, code, subjects, params}: the same problem always has the same id. */
    id: z.string().regex(/^[0-9a-f]{64}$/),
    check: z.string().min(1),
    code: z.string().min(1),
    severity: z.enum(["blocking", "warning", "info"]),
    /** Who sees it. */
    audience: z.array(Audience).min(1),
    /** Who may close it. Findings raised by a model can never be closed by code. */
    decidedBy: Audience,
    origin: z.literal("deterministic"),
    subjects: z.array(z.object({ kind: SubjectKind, id: z.string().min(1) }).strict()),
    params: z.record(z.string(), Scalar),
    /** Plain language, rendered from code and params for the first audience. */
    message: z.string().min(1),
    /** Where the booklet is cited: page number and the quoted words. */
    source: z.array(z.object({ page: z.number().int(), quote: z.string().optional() }).strict()),
    example: z.record(z.string(), z.union([Scalar, z.array(Scalar)])).optional(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;
export type Subject = Finding["subjects"][number];
export type FindingParams = Finding["params"];

export type FindingInput = Omit<Finding, "id" | "message" | "origin">;

export function makeFinding(input: FindingInput): Finding {
  const subjects = [...input.subjects].sort((a, b) => (a.kind + "\u0000" + a.id).localeCompare(b.kind + "\u0000" + b.id));
  const id = createHash("sha256")
    .update(canonicalJson({ check: input.check, code: input.code, subjects, params: input.params }), "utf8")
    .digest("hex");
  const first = input.audience[0];
  if (first === undefined) throw new Error("finding needs at least one audience");
  const message = render(input.code, input.params, first);
  return FindingSchema.parse({ ...input, subjects, id, message, origin: "deterministic" });
}

/** A clinician-approved departure from the booklet, matched to an ungrounded number. */
export type ApprovedDeviation = { subject: string; number: number; by: string; note: string };

/** A clinician-approved case where a less urgent rule is checked before a more urgent one: [firstRuleId, overriddenRuleId]. */
export type ApprovedException = { rules: readonly [string, string]; by: string; note: string };

export type CheckContext = {
  model: Model;
  document?: SourceDocument;
  approvedDeviations?: readonly ApprovedDeviation[];
  approvedExceptions?: readonly ApprovedException[];
  /** Largest number of answer combinations the logic checks will go through (default 200000); more means NOT_PROVEN. */
  maxGridPoints?: number;
  /** What the guideline reader found in the booklet (danger signs, passages). Without it the coverage checks do not run. */
  extraction?: Extraction;
  /** Children whose result the clinician knows. Without them the golden-case check does not run. */
  goldenCases?: readonly GoldenCase[];
  /** Form settings (title, icon, who the form is for, default task window). Without them the compile-readiness check does not run. */
  compileSettings?: CompileSettings;
  /** The version that is already in use in the field, to catch renamed or removed fields. */
  deployed?: Model;
};

export type SourceDocument = {
  /** sha256 (hex) of the uploaded guideline file, as recorded by the extraction. */
  docSha256: string;
  /** pdf page number -> blocks of that page, in reading order. */
  pages: ReadonlyMap<number, readonly { id: string; text: string }[]>;
  /** All blocks of the page joined with a newline, or undefined when the page is not in the document. */
  pageText(page: number): string | undefined;
};

const InputBlocks = z.looseObject({
  doc_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pages: z.array(
    z.looseObject({
      pdf_page: z.number().int().min(0),
      blocks: z.array(z.looseObject({ block_id: z.string().min(1), text: z.string() })),
    }),
  ),
});

/** Validates the shape of extraction/input_blocks.json (doc_sha256, pages -> blocks) and builds the page lookup. Throws on bad input. */
export function loadSourceDocument(json: unknown): SourceDocument {
  const parsed = InputBlocks.parse(json);
  const seen = new Set<string>();
  const pages = new Map<number, { id: string; text: string }[]>();
  for (const p of parsed.pages) {
    const blocks = pages.get(p.pdf_page) ?? [];
    for (const b of p.blocks) {
      if (seen.has(b.block_id)) throw new Error(`duplicate block id ${b.block_id}`);
      seen.add(b.block_id);
      blocks.push({ id: b.block_id, text: b.text });
    }
    pages.set(p.pdf_page, blocks);
  }
  return {
    docSha256: parsed.doc_sha256,
    pages,
    pageText: (page) => pages.get(page)?.map((b) => b.text).join("\n"),
  };
}

export const OFFICER: Audience[] = ["program_officer"];
export const BOTH: Audience[] = ["program_officer", "clinician"];
