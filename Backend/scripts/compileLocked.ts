// Compile job: build ONE locked logic model version into a CHT project and run the real cht-conf on it.
// It refuses any version that is not locked with the program officer's and then the clinician's signature
// on its current content, that is not the newest locked version, whose stored bytes changed since the save,
// or whose signatures were given with other compile settings than --settings; the checks run again first
// (BRD AR-08, AR-09; DEC-019, DEC-020). Compile is NOT a Lambda step: cht-conf needs Python and,
// later, the test harness needs Chromium, so this runs as a job on the build host (EC2, DEC-014; not built).
//
// Run from Backend/ against the deployed store (DynamoDB + S3):
//   AWS_REGION=us-west-2 ARTIFACT_BUCKET=... TABLE_RUNS=... TABLE_STEPS=... TABLE_VERSIONS=... \
//   TABLE_COMMENTS=... TABLE_AUDIT=... \
//   npx tsx scripts/compileLocked.ts --run <runId> --version <n> --settings <settings.json> [--out <dir>]
// Exit codes: 0 built and cht-conf passed; 2 usage or environment; 3 refused (not locked); 4 cht-conf failed;
// 5 compiled but cht-conf is not installed (compile-demo/tools; run `npm install` there).
//
// The pipeline demo (pipeline-demo/run.ts) calls runCompileJob with the in-memory store.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { artifactKey, type ArtifactStore } from "../src/artifacts/artifactStore.js";
import { S3ArtifactStore } from "../src/artifacts/s3ArtifactStore.js";
import { compileLockedVersion } from "../src/compiler/compileLocked.js";
import { ApprovalError } from "../src/compiler/compileSnapshot.js";
import type { CompileSettings, Manifest } from "../src/compiler/types.js";
import { recordProcess } from "../src/metrics/record.js";
import { parseCompileSettings, type CheckInputsProvider } from "../src/signoff/checkInputs.js";
import { Signoff, SignoffError } from "../src/signoff/signoff.js";
import { DynamoStore } from "../src/store/dynamoStore.js";
import type { Store } from "../src/store/store.js";
import { chtToolsInstalled, runChtConf, type ChtRunResult } from "../compile-demo/chtConf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

export type CompileJobStatus = "refused" | "cht_skipped" | "cht_failed" | "pass";

export interface CompileJobOptions {
  store: Store;
  artifacts: ArtifactStore;
  runId: string;
  n: number;
  settings: CompileSettings;
  /** project/, logs/, manifest.json and cht-result.json are (re)written here. */
  outDir: string;
  log?: (msg: string) => void;
  now?: () => number;
  /** Default: cht-conf runs when compile-demo/tools has it installed. */
  runCht?: boolean;
  /** Golden cases of the run for the checks. Default: defaultCheckInputs (run artifacts, then env). */
  inputs?: CheckInputsProvider;
}

export interface CompileJobResult {
  status: CompileJobStatus;
  reason?: string;
  manifest?: Manifest;
  cht?: ChtRunResult;
  projectDir: string;
}

// Recorded as the "compile" process of this version, so its latency is in the run totals (DEC-003).
export function runCompileJob(opts: CompileJobOptions): Promise<CompileJobResult> {
  return recordProcess(
    opts.store,
    { runId: opts.runId, process: "compile", versionId: String(opts.n), now: opts.now ?? Date.now },
    () => compileJob(opts),
  );
}

async function compileJob(opts: CompileJobOptions): Promise<CompileJobResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const projectDir = path.join(opts.outDir, "project");
  const logsDir = path.join(opts.outDir, "logs");

  let compiled;
  try {
    // Check the lock BEFORE touching the output folder, so a refused job never removes an earlier build.
    try {
      await new Signoff({
        store: opts.store,
        artifacts: opts.artifacts,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
      }).verifyLocked(opts.runId, opts.n, { settings: opts.settings });
    } catch (e) {
      if (e instanceof SignoffError) throw new ApprovalError(`release build refused for run ${opts.runId} version ${opts.n}: ${e.message}`);
      throw e;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
    mkdirSync(opts.outDir, { recursive: true });
    compiled = await compileLockedVersion({
      store: opts.store,
      artifacts: opts.artifacts,
      runId: opts.runId,
      n: opts.n,
      projectDir,
      settings: opts.settings,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
    });
  } catch (e) {
    if (e instanceof ApprovalError) {
      log(`compile refused: ${e.message}`);
      return { status: "refused", reason: e.message, projectDir };
    }
    throw e;
  }
  const { manifest, sha } = compiled;
  writeFileSync(path.join(opts.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`compiled ${manifest.formId} ${manifest.version} (release) from run ${opts.runId} version ${opts.n}: ${manifest.files.length} files`);

  if (opts.runCht === false || !chtToolsInstalled()) {
    const reason = "cht-conf is not installed in Backend/compile-demo/tools (run `npm install` there, network needed once); the CHT project was generated but not compiled by cht-conf";
    log(`cht-conf skipped: ${reason}`);
    return { status: "cht_skipped", reason, manifest, projectDir };
  }

  const tmpRoot = mkdtempSync(path.join(tmpdir(), "compile-locked-"));
  const sanitize = (s: string): string =>
    s.replace(/\u001b\[[0-9;]*m/g, "").split(tmpRoot).join("<tmp>").split(repo).join("<repo>").split(homedir()).join("~");
  try {
    const cht = await runChtConf({ projectDir, logsDir, formId: manifest.formId, tmpRoot, sanitize, log });
    const forFile = { ...cht, steps: cht.steps.map((s) => ({ ...s, log: sanitize(s.log) })) };
    writeFileSync(path.join(opts.outDir, "cht-result.json"), `${JSON.stringify(forFile, null, 2)}\n`);
    // Keep the cht-conf outputs next to the manifest in the artifact store.
    for (const rel of [`forms/app/${manifest.formId}.xml`, "app_settings.json"]) {
      try {
        await opts.artifacts.put(artifactKey(opts.runId, "compile", sha, compiled.settingsSha, rel), readFileSync(path.join(projectDir, rel)));
      } catch {
        // Missing when a cht-conf step failed; the result says so.
      }
    }
    log(`cht-conf: ${cht.allPass ? "PASS" : "FAIL"}`);
    return { status: cht.allPass ? "pass" : "cht_failed", manifest, cht: forFile, projectDir };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const runId = arg("--run");
  const nRaw = arg("--version");
  const settingsPath = arg("--settings");
  if (!runId || !nRaw || !/^\d+$/.test(nRaw) || !settingsPath) {
    console.log("usage: tsx scripts/compileLocked.ts --run <runId> --version <n> --settings <settings.json> [--out <dir>]");
    return 2;
  }
  const need = ["ARTIFACT_BUCKET", "TABLE_RUNS", "TABLE_STEPS", "TABLE_VERSIONS", "TABLE_COMMENTS", "TABLE_AUDIT"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`missing environment variables: ${missing.join(", ")} (same values as the orchestrator; see Backend/README.md)`);
    return 2;
  }
  const env = process.env as Record<string, string>;
  const region = env["AWS_REGION"] || "us-west-2";
  const store = new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region })), {
    runs: env["TABLE_RUNS"]!,
    steps: env["TABLE_STEPS"]!,
    versions: env["TABLE_VERSIONS"]!,
    comments: env["TABLE_COMMENTS"]!,
    audit: env["TABLE_AUDIT"]!,
  });
  const artifacts = new S3ArtifactStore(new S3Client({ region }), env["ARTIFACT_BUCKET"]!);
  const settings: CompileSettings = parseCompileSettings(JSON.parse(readFileSync(path.resolve(settingsPath), "utf8")));
  const outDir = path.resolve(arg("--out") ?? mkdtempSync(path.join(tmpdir(), "compile-locked-out-")));
  const res = await runCompileJob({ store, artifacts, runId, n: Number(nRaw), settings, outDir });
  console.log(`result: ${res.status}${res.reason ? ` (${res.reason})` : ""}; output in ${outDir}`);
  return { pass: 0, refused: 3, cht_failed: 4, cht_skipped: 5 }[res.status];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.log(`compile job failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
