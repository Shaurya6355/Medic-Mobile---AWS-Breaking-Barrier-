/**
 * TEST-ONLY. NEVER IMPORT FROM src/.
 *
 * resolveForDemo stands in for a person editing the logic model in the review UI, so the tests and the
 * pipeline demo can walk the whole sign-off chain without a UI. It applies fixed, synthetic edits:
 * - program_officer: fills meta.guideline.publisher / edition when they are "Not recorded" (the public
 *   booklet's title page says WHO and UNICEF, July 2014) and marks every open question routed to the
 *   program officer as resolved with a demo answer;
 * - clinician: marks every open question routed to the clinician as resolved with a demo answer.
 * The answers are placeholders that accept the draft as written. They are NOT clinical decisions and
 * must never be shown as such. Every edit makes a new version (AR-01): meta.version is bumped and
 * meta.parent_version points at the input.
 */
import type { Model } from "../../src/logic/schema.js";

export type DemoRole = "program_officer" | "clinician";

export const DEMO_ANSWER =
  "TEST-ONLY demo answer (synthetic): accepted as drafted so the demo can continue. Not a clinical or programme decision.";

export function resolveForDemo(model: Model, role: DemoRole): Model {
  const m = structuredClone(model);
  m.meta.parent_version = model.meta.version;
  m.meta.version = model.meta.version + 1;
  m.meta.created_by = `demo-${role}`;
  m.meta.change_note = `TEST-ONLY demo edit by the ${role === "program_officer" ? "program officer" : "clinician"}: open questions routed to them marked resolved.`;
  if (role === "program_officer") {
    if (m.meta.guideline.publisher === "Not recorded") m.meta.guideline.publisher = "WHO and UNICEF";
    if (m.meta.guideline.edition === "Not recorded") m.meta.guideline.edition = "July 2014";
  }
  for (const q of m.open_questions) {
    if (q.route_to === role && q.status === "open") {
      q.status = "resolved";
      q.resolution = DEMO_ANSWER;
    }
  }
  return m;
}
