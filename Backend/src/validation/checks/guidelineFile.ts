import { OFFICER, makeFinding } from "../finding.js";
import type { CheckContext, Finding } from "../finding.js";

export const CHECK = "guidelineFile";

/** The logic model must have been written from the very file that was uploaded: the recorded file fingerprints must be equal. */
export function guidelineFile(ctx: CheckContext): Finding[] {
  const doc = ctx.document;
  if (doc === undefined) return []; // quoteGrounding reports the missing document
  const model = ctx.model.meta.guideline.file_sha256;
  if (model === doc.docSha256) return [];
  return [
    makeFinding({
      check: CHECK,
      code: "GUIDELINE_FILE_MISMATCH",
      severity: "blocking",
      audience: OFFICER,
      decidedBy: "program_officer",
      subjects: [{ kind: "document", id: "guideline" }],
      params: { title: ctx.model.meta.guideline.title, edition: ctx.model.meta.guideline.edition },
      source: [],
    }),
  ];
}
