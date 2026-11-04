import { parseModel } from "../logic/schema.js";

// The seam every logic model body passes through: the fill_logic step (AI draft) and the
// API (versions saved by a person) use the same validator, so AI drafts and hand edits
// take the same path (design rule 3). Production wires parseModelValidator.
export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

export interface LogicModelValidator {
  validate(body: unknown): ValidationResult;
}

/** The logic model schema (schema_version "1.0", src/logic/schema.ts). Structure only; the checks do the rest. */
export const parseModelValidator: LogicModelValidator = {
  validate(body) {
    const r = parseModel(body);
    return r.ok ? { ok: true } : { ok: false, issues: r.issues };
  },
};

/** Accepts any plain object. For tests of the orchestration that do not care about the body. */
export const acceptAnyObjectValidator: LogicModelValidator = {
  validate(body) {
    if (body !== null && typeof body === "object" && !Array.isArray(body)) return { ok: true };
    return { ok: false, issues: ["Logic model body must be a plain object"] };
  },
};
