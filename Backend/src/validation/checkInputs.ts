import { readFileSync } from "node:fs";
import type { CompileSettings } from "../compiler/types.js";
import { loadGoldenCases } from "./context.js";
import type { GoldenCase } from "./context.js";
import type { CheckContext } from "./finding.js";

/**
 * Supplying the optional inputs of the checks (red team 1, item 8). Without test cases the golden-case check is
 * silent and severityOrder blocks with URGENT_OVERLAP_UNTESTED wherever two equally urgent results overlap; without
 * form settings compileReady is silent. Production (src/signoff) should build its context with this.
 */

/** Reads and validates a golden-case file ([{ id, description, answers, expected_outcome, expected_rule?, note? }]). Throws on bad input. */
export function loadGoldenCasesFile(path: string): GoldenCase[] {
  return loadGoldenCases(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export type OptionalInputs = {
  /** Raw golden-case JSON or already loaded cases; validated with loadGoldenCases. */
  goldenCases?: unknown;
  compileSettings?: CompileSettings;
};

/** The check context with the test cases and form settings added (each only when given), test cases validated. */
export function withCheckInputs(ctx: CheckContext, inputs: OptionalInputs): CheckContext {
  return {
    ...ctx,
    ...(inputs.goldenCases !== undefined ? { goldenCases: loadGoldenCases(inputs.goldenCases) } : {}),
    ...(inputs.compileSettings !== undefined ? { compileSettings: inputs.compileSettings } : {}),
  };
}
