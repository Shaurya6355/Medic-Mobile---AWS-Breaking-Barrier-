/**
 * The compile guard (BRD AR-08, GR-01; DEC-019): reads a version from the store and artifacts and builds it
 * for release only when it is locked with the program officer's and the clinician's signatures on its
 * current content and the checks, run now with the build settings, allow a build (DEC-019, DEC-020).
 * compileSnapshot has no other release path: it never accepts lock evidence built by the caller.
 *
 * Not a Lambda step (DEC-014): it runs as a job on the build host (EC2 later), see scripts/compileLocked.ts.
 */
import { artifactKey, type ArtifactStore } from "../artifacts/artifactStore.js";
import type { Version } from "../domain/types.js";
import { CHECKS_VERSION, type CheckInputsProvider } from "../signoff/checks.js";
import type { Store } from "../store/store.js";
import { releaseBuild } from "./compileSnapshot.js";
import type { FlowLimits } from "./flowMode.js";
import type { CompileSettings, Manifest } from "./types.js";

export interface CompileLockedOptions {
  store: Store;
  artifacts: ArtifactStore;
  runId: string;
  n: number;
  projectDir: string;
  /** The build settings. They must be the ones both signers' checks used (settingsSha on the signatures). */
  settings: CompileSettings;
  flowLimits?: FlowLimits;
  now?: () => number;
  /** Golden cases of the run for the checks run before the build. Default: defaultCheckInputs. */
  inputs?: CheckInputsProvider;
}

export interface CompileLockedResult {
  manifest: Manifest;
  sha: string;
  /** sha256 of the build settings (part of the manifest key and the audit record). */
  settingsSha: string;
  version: Version;
  manifestKey: string;
}

export async function compileLockedVersion(opts: CompileLockedOptions): Promise<CompileLockedResult> {
  const now = opts.now ?? Date.now;
  const { manifest, locked } = await releaseBuild(
    { store: opts.store, artifacts: opts.artifacts, runId: opts.runId, n: opts.n, now, ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}) },
    { projectDir: opts.projectDir, settings: opts.settings, ...(opts.flowLimits !== undefined ? { flowLimits: opts.flowLimits } : {}) },
  );
  // One manifest per content AND settings: two builds with different settings never share a key.
  const manifestKey = artifactKey(opts.runId, "compile", locked.sha, locked.settingsSha, "manifest.json");
  await opts.artifacts.put(manifestKey, JSON.stringify(manifest, null, 2), "application/json");
  await opts.store.appendAudit(opts.runId, {
    at: now(),
    type: "compiled",
    detail: {
      n: opts.n,
      modelSha: locked.sha,
      settingsSha: locked.settingsSha,
      bodySha256: locked.version.bodySha256 ?? null,
      checksVersion: CHECKS_VERSION,
      inputsSha: locked.findings.inputsSha,
      goldenCases: locked.inputs.goldenCases !== undefined,
      checksNotRun: locked.findings.checksNotRun,
      formVersion: manifest.version,
      files: manifest.files.length,
    },
  });
  return { manifest, sha: locked.sha, settingsSha: locked.settingsSha, version: locked.version, manifestKey };
}
