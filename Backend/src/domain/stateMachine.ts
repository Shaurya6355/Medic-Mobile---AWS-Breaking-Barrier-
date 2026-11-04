import type { RunState } from "../contract/schemas.js";

// Run states. The work states (ingesting .. checking) are advanced by the orchestrator and can be
// resumed after a failure. The sign-off states (BRD AR-01 to AR-05, DEC-019) wait for a person:
// awaiting_officer -> awaiting_clinician -> locked. A newly saved version always goes back through
// checking, from any review state, locked included (AR-01: an edit is a new version, never a change
// in place; the locked version stays locked). A waiting state never fails: nothing runs in it.
const table: Record<RunState, readonly RunState[]> = {
  created: ["ingesting", "failed"],
  ingesting: ["extracting", "failed"],
  extracting: ["filling_logic", "failed"],
  // checking when the checks step is registered after fill_logic; in_review when it is not.
  filling_logic: ["checking", "in_review", "failed"],
  in_review: ["checking", "failed"],
  checking: ["awaiting_officer", "in_review", "failed"],
  awaiting_officer: ["awaiting_clinician", "checking"],
  awaiting_clinician: ["locked", "checking"],
  locked: ["checking"],
  // Resume: back into any resumable work state.
  failed: ["ingesting", "extracting", "filling_logic", "checking"],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return table[from].includes(to);
}
