import type { Model } from "../../logic/schema.js";
import { makeFinding } from "../finding.js";
import type { CheckContext, Finding, Subject } from "../finding.js";
import { describeDerived, describeQuestion, derivedSubject, questionSubject } from "../describe.js";

export const CHECK = "fieldNames";

/**
 * Names the form builder writes itself (see compiler/form.ts) and names the health platform (CHT) and the
 * form standard keep for report data. A question or calculated value with one of these names would clash.
 * Compared in lower case.
 */
export const RESERVED_FIELD_NAMES: readonly string[] = [
  // written by the form builder
  "inputs", "source", "source_id", "contact", "patient_uuid", "patient_id", "patient_name", "outcome", "results",
  // the platform's report data
  "_id", "_rev", "name", "meta", "data", "instanceid", "form", "type", "content_type", "fields", "reported_date", "from",
  "place_id", "place_uuid", "place_name", "contact_id", "xmlns", "instancename", "deprecatedid",
];

const WHY_RESERVED: Record<string, string> = {
  outcome: "it holds the result the assessment arrives at",
  results: "it is the screen that shows the result",
  inputs: "it holds the link between the report and the child",
  source: "it records where the form was opened from",
  source_id: "it records where the form was opened from",
  contact: "it holds the link between the report and the child",
};

type Named = { id: string; item: string; subject: Subject };

function named(model: Model): Named[] {
  return [
    ...model.questions.map((q) => ({ id: q.id, item: describeQuestion(q), subject: questionSubject(q) })),
    ...model.derived.map((d) => ({ id: d.id, item: describeDerived(d), subject: derivedSubject(d) })),
  ];
}

/**
 * Question and calculated-value names are safe for the form (start with a lowercase letter, lowercase letters,
 * digits and underscores, at most 32 characters), are not reserved, and, when the version in use in the field
 * is known, none of its names disappeared (renaming breaks reports already filled in).
 */
export function fieldNames(ctx: CheckContext): Finding[] {
  const { model } = ctx;
  const out: Finding[] = [];
  const all = named(model);
  const questionIds = new Set(model.questions.map((q) => q.id));
  for (const n of all) {
    const lower = n.id.toLowerCase();
    const common = { check: CHECK, subjects: [n.subject], source: [] as { page: number; quote?: string }[] };
    let problem = "";
    if (!/^[a-z][a-z0-9_]*$/.test(n.id)) problem = "it does not start with a lowercase letter or has characters other than lowercase letters, digits and underscores";
    else if (n.id.length > 32) problem = `it is ${n.id.length} characters long, and the limit is 32`;
    if (problem !== "") {
      out.push(
        makeFinding({ ...common, code: "INVALID_FIELD_NAME", severity: "blocking", audience: ["program_officer"], decidedBy: "program_officer", params: { name: n.id, item: n.item, problem } }),
      );
    }
    let why = "";
    if (RESERVED_FIELD_NAMES.includes(lower)) why = WHY_RESERVED[lower] ?? "the form or the health platform uses it for its own data";
    else if (lower.startsWith("outcome_")) why = "names starting with outcome_ are used for the texts of the results";
    else if (lower.startsWith("q_") && questionIds.has(lower.slice(2))) why = `it is already the name of the screen of the question "${lower.slice(2)}"`;
    if (why !== "") {
      out.push(
        makeFinding({ ...common, code: "RESERVED_FIELD_NAME", severity: "blocking", audience: ["program_officer"], decidedBy: "program_officer", params: { name: n.id, item: n.item, because: why } }),
      );
    }
  }
  if (ctx.deployed !== undefined) {
    const now = new Set(all.map((n) => n.id));
    for (const d of named(ctx.deployed)) {
      if (now.has(d.id)) continue;
      for (const role of ["clinician", "program_officer"] as const) {
        out.push(
          makeFinding({
            check: CHECK,
            code: "FIELD_RENAMED",
            severity: "blocking",
            audience: [role],
            decidedBy: role,
            subjects: [d.subject],
            params: { name: d.id, item: d.item, confirmer: role },
            source: [],
          }),
        );
      }
    }
  }
  return out;
}
