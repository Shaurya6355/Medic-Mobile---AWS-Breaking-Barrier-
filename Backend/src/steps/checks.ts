import type { Step, StepResult } from "../engine/step.js";
import { computeFindings, type CheckInputsProvider } from "../signoff/checks.js";

/**
 * Automatic checks (BR-11, GR-03), registered after fill_logic: runChecks over the latest version with the
 * run's guideline text and extraction, stored as the findings artifact keyed to the modelSha (with the
 * plain-language view for each audience). No model call. Content findings never fail the step: they are
 * the output, and the sign-off gates read them. Versions saved later are checked by onVersionSaved; when that
 * fails the run is left failed at this step, so resume runs it again on the latest version (DEC-020).
 * The golden cases and compile settings come from `inputs` (default: defaultCheckInputs, DEC-020).
 */
export function createChecksStep(opts: { inputs?: CheckInputsProvider } = {}): Step {
  return {
    name: "checks",
    runState: "checking",
    async run(ctx): Promise<StepResult> {
      const runId = ctx.run.runId;
      const versions = await ctx.store.listVersions(runId);
      const latest = versions.reduce<number | undefined>((m, v) => (m === undefined || v.n > m ? v.n : m), undefined);
      if (latest === undefined) throw new Error(`checks: run ${runId} has no logic model version to check`);
      const { record, key } = await computeFindings(
        { store: ctx.store, artifacts: ctx.artifacts, now: ctx.now, ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}) },
        runId,
        latest,
      );
      return { artifactRefs: { findings: key, modelSha: record.modelSha, version: String(latest), checksVersion: record.checksVersion } };
    },
  };
}
