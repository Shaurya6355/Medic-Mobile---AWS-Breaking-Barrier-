import type { RunState } from "../contract/schemas.js";

const table: Record<RunState, readonly RunState[]> = {
  created: ["ingesting", "failed"],
  ingesting: ["extracting", "failed"],
  extracting: ["filling_logic", "failed"],
  filling_logic: ["in_review", "failed"],
  in_review: ["checking", "failed"],
  checking: ["in_review", "failed"],
  // Resume: back into any resumable work state.
  failed: ["ingesting", "extracting", "filling_logic", "checking"],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return table[from].includes(to);
}
