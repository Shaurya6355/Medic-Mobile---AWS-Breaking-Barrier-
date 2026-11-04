// The logic model body is opaque everywhere in the orchestrator. The real schema
// has not been supplied yet, so this seam holds a placeholder validator. When the
// schema arrives it replaces acceptAnyObjectValidator in this one place; no other
// file needs to change.
export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

export interface LogicModelValidator {
  validate(body: unknown): ValidationResult;
}

export const acceptAnyObjectValidator: LogicModelValidator = {
  validate(body) {
    if (body !== null && typeof body === "object" && !Array.isArray(body)) return { ok: true };
    return { ok: false, issues: ["Logic model body must be a plain object"] };
  },
};
