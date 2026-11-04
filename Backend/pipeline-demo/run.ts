// End-to-end pipeline demo with real approval rules (DEC-019). Synthetic and public data only.
// Run from Backend/:  npm run pipeline:demo
//
// extract output -> fill_logic (FakeModelClient returns the hand-written draft, no Bedrock call) -> automatic
// checks -> findings -> signing BLOCKED while blockers exist -> compile REFUSED for an unsigned version ->
// officer fixes (new version) -> officer signs -> clinician blocked -> clinician answers (new version, the
// officer's signature does not carry over) -> officer signs -> separation of duties and stale-sha refusals
// -> clinician signs -> LOCKED -> compile with cht-conf (skipped with a message when compile-demo/tools is
// not installed) -> an edit after the lock makes a new unsigned version while the locked one stays releasable.
//
// Everything goes through the real Orchestrator, the real API routes (Fastify inject) and the real store
// rules (MemoryStore). The edits are made by tests/helpers/resolveForDemo.ts (TEST-ONLY): its answers to the
// open questions are placeholders, not clinical decisions. Outputs: pipeline-demo/output/ (see Backend/README.md, "Sign-off").
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LightMyRequestResponse } from "fastify";
import { buildServer, type OrchestratorPort } from "../src/api/server.js";
import { MemoryArtifactStore, artifactKey } from "../src/artifacts/artifactStore.js";
import type { CompileSettings } from "../src/compiler/types.js";
import { routes } from "../src/contract/routes.js";
import { Orchestrator } from "../src/engine/engine.js";
import type { Step } from "../src/engine/step.js";
import type { Model } from "../src/logic/index.js";
import { FakeModelClient } from "../src/model/modelClient.js";
import { Signoff } from "../src/signoff/signoff.js";
import { createChecksStep } from "../src/steps/checks.js";
import { createFillLogicStep } from "../src/steps/fillLogic.js";
import { parseModelValidator } from "../src/steps/logicModelValidator.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { resolveForDemo } from "../tests/helpers/resolveForDemo.js";
import { runCompileJob } from "../scripts/compileLocked.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "..");
const OUT = path.join(HERE, "output");
const RUN = "pipeline-demo";
const OFFICER = "demo-officer-amara";
const CLINICIAN = "demo-clinician-tomas";

const blocksText = readFileSync(path.join(BACKEND, "extraction", "input_blocks.json"), "utf8");
const extractionText = readFileSync(path.join(BACKEND, "extraction", "extraction_output.json"), "utf8");
const draftText = readFileSync(path.join(BACKEND, "tests", "fixtures", "fill", "draft-cough.json"), "utf8");
const DOC_SHA = (JSON.parse(blocksText) as { doc_sha256: string }).doc_sha256;
const { _note: _ignored, ...settings } = JSON.parse(readFileSync(path.join(BACKEND, "compile-demo", "settings.demo.json"), "utf8")) as CompileSettings & { _note?: string };

// ---------------------------------------------------------------- trace
const trace: string[] = [];
const problems: string[] = [];
let stepNo = 0;
const say = (line = ""): void => {
  trace.push(line);
  process.stdout.write(`${line}\n`);
};
const heading = (title: string): void => {
  stepNo++;
  say("");
  say(`## ${stepNo}. ${title}`);
  say("");
};
const expectThat = (ok: boolean, what: string): void => {
  say(`   ${ok ? "OK" : "UNEXPECTED"}: ${what}`);
  if (!ok) problems.push(`step ${stepNo}: ${what}`);
};
const short = (sha: string): string => `${sha.slice(0, 12)}...`;

// A fixed clock so the trace and outputs are the same on every run.
let t = Date.UTC(2026, 10, 4, 9, 0, 0);
const now = (): number => (t += 1000);

// ---------------------------------------------------------------- setup
const store = new MemoryStore();
const artifacts = new MemoryArtifactStore();
const model = new FakeModelClient([{ raw: draftText, usage: { inputTokens: 0, outputTokens: 0, modelId: "fake.demo-model" } }]);

// Ingest and extract are not re-run here: their outputs are the committed records of the public booklet.
const providedStep = (name: string, runState: Step["runState"], key: string, body: string): Step => ({
  name,
  runState,
  async run() {
    await artifacts.put(artifactKey(RUN, ...key.split("/")), body, "application/json");
    return { artifactRefs: { [key]: artifactKey(RUN, ...key.split("/")) } };
  },
});

const orchestrator = new Orchestrator({
  store,
  artifacts,
  model,
  steps: [
    providedStep("ingest", "ingesting", "ingest/input_blocks.json", blocksText),
    providedStep("extract", "extracting", "extract/extraction_output.json", extractionText),
    createFillLogicStep({
      validator: parseModelValidator,
      modelId: "fake.demo-model",
      promptPath: path.join(BACKEND, "extraction", "fill_prompt.txt"),
      pathwayId: "cough_fast_breathing",
      guideline: { title: "Caring for the sick child in the community: Chart booklet" },
    }),
    createChecksStep(),
  ],
  finalState: "awaiting_officer",
  owner: "pipeline-demo",
  leaseMs: 60_000,
  runnerOpts: { maxAttempts: 1, backoffMs: () => 0, sleep: async () => {}, prices: {} },
  now,
});
const signoff = new Signoff({ store, artifacts, now });
const port: OrchestratorPort = {
  createRun: () => Promise.reject(new Error("not used in the demo")),
  resume: (id) => orchestrator.resume(id),
  prepareResume: (id) => orchestrator.prepareResume(id),
  onUploaded: (id) => orchestrator.onUploaded(id),
  resumeAll: () => orchestrator.resumeAll(),
  activeCount: () => orchestrator.activeCount(),
  lastStatusChange: () => orchestrator.lastStatusChange(),
};
const api = buildServer({
  orchestrator: port,
  store,
  artifacts,
  validator: parseModelValidator,
  presign: async (k) => k,
  onVersionSaved: (runId, n) => signoff.onVersionSaved(runId, n),
  signoff,
  maxPages: 200,
  now,
});

type Json = Record<string, any>;
const call = async (method: "GET" | "POST", url: string, payload?: object): Promise<{ status: number; body: Json }> => {
  const res: LightMyRequestResponse = await api.inject({ method, url, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as Json };
};
const sign = (n: number, role: "program_officer" | "clinician", userId: string, modelSha: string, endpoint: string = role) =>
  call("POST", routes.sign(RUN, n, endpoint), { role, userId, modelSha });
const status = async (n: number): Promise<Json> => (await call("GET", routes.status(RUN, n))).body;
const body = async (n: number): Promise<Model> => (await call("GET", routes.version(RUN, n))).body["body"] as Model;
const saveVersion = async (parent: number, author: string, authorRole: "program_officer" | "clinician", m: Model): Promise<number> => {
  const r = await call("POST", routes.versions(RUN), { parentVersion: parent, author, authorRole, body: m });
  expectThat(r.status === 201, `POST versions -> ${r.status} (new version ${r.body["n"]}, author ${author})`);
  return r.body["n"] as number;
};
const runStates = async (): Promise<string[]> =>
  (await store.listAudit(RUN))
    .filter((a) => a.type === "run_state")
    .map((a) => {
      const d = a.detail as { from: string | null; to: string };
      return `${d.from ?? "(new)"} -> ${d.to}`;
    });
const showSign = (label: string, r: { status: number; body: Json }): void => {
  say(`   ${label}: HTTP ${r.status} ${r.body["error"] ?? r.body["status"] ?? ""}${r.body["message"] ? ` - ${r.body["message"]}` : ""}`);
};
const compileOut = path.join(OUT, "compile");
const compile = async (n: number) =>
  runCompileJob({ store, artifacts, runId: RUN, n, settings, outDir: compileOut, log: (m) => say(`   [compile] ${m}`), now });

// ---------------------------------------------------------------- run
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
say("# Pipeline demo trace");
say("");
say("Synthetic run on the public WHO/UNICEF cough booklet. FakeModelClient (no Bedrock call). Demo users:");
say(`${OFFICER} (program officer) and ${CLINICIAN} (clinician). Edits by tests/helpers/resolveForDemo.ts (TEST-ONLY;`);
say("its answers are placeholders, not clinical decisions). Fixed clock, so this file is the same on every run");
say("except the cht-conf timings in compile/logs.");

heading("Extract output -> fill_logic -> automatic checks (orchestrator)");
await store.createRun({ runId: RUN, state: "created", createdAt: now() });
await store.appendAudit(RUN, { at: now(), type: "run_state", detail: { from: null, to: "created", filename: "Cough_Guideline.pdf" } });
await orchestrator.onUploaded(RUN, DOC_SHA);
for (const s of await store.listSteps(RUN)) {
  say(`   step ${s.step.padEnd(10)} ${s.status.padEnd(9)} tokens in/out ${s.inputTokens}/${s.outputTokens}  -> ${Object.keys(s.artifactRefs).join(", ")}`);
}
say(`   run states: ${(await runStates()).join(" | ")}`);
const run1 = (await store.getRun(RUN))!;
expectThat(run1.state === "awaiting_officer", `run is in ${run1.state} (expected awaiting_officer)`);

heading("Findings for version 1 (GET findings, per audience)");
const f1 = (await call("GET", routes.findings(RUN, 1))).body;
const sha1 = f1["modelSha"] as string;
const bySeverity = (fs: Json[]) => ["blocking", "warning", "info"].map((s) => `${fs.filter((f) => f["severity"] === s).length} ${s}`).join(", ");
say(`   modelSha ${short(sha1)}; claim ${f1["claim"]}; ${bySeverity(f1["findings"] as Json[])}`);
say(`   gates: ${f1["gates"]["summary"]}`);
const summaries: Json = {};
for (const role of ["program_officer", "clinician"] as const) {
  const v = (await call("GET", `${routes.findings(RUN, 1)}?audience=${role}`)).body;
  const blocking = ((v["groups"] as Json[]).find((g) => g["severity"] === "blocking")?.["findings"] ?? []) as Json[];
  const yours = blocking.filter((f) => f["yours"]);
  say(`   ${role}: ${yours.length} blocking item(s) for them to settle, for example:`);
  for (const f of yours.slice(0, 3)) say(`     - ${String(f["message"]).split("\n")[0]!.slice(0, 160)}`);
  summaries[role] = (v["groups"] as Json[]).flatMap((g) =>
    (g["findings"] as Json[]).map((f) => ({ severity: f["severity"], code: f["code"], decidedBy: f["decidedBy"], yours: f["yours"], message: f["message"] })),
  );
}
writeFileSync(path.join(OUT, "findings-v1.json"), `${JSON.stringify({ modelSha: sha1, claim: f1["claim"], gates: f1["gates"], byAudience: summaries }, null, 2)}\n`);

heading("Signing is BLOCKED while blockers exist; compile is REFUSED for an unsigned version");
const b1 = await sign(1, "program_officer", OFFICER, sha1);
showSign("officer signs v1", b1);
expectThat(b1.status === 422 && b1.body["error"] === "blocked", `officer refused with 422 blocked (${(b1.body["blockers"] as Json[] | undefined)?.length ?? 0} blockers listed)`);
const b2 = await sign(1, "clinician", CLINICIAN, sha1);
showSign("clinician signs v1", b2);
expectThat(b2.status === 409 && b2.body["error"] === "officer_signature_required", "clinician refused with 409: the officer signs first");
const c1 = await compile(1);
expectThat(c1.status === "refused", `compile of v1 refused (${c1.reason ?? c1.status})`);

heading("Second pass: the program officer fixes their items (new version 2)");
const n2 = await saveVersion(1, OFFICER, "program_officer", resolveForDemo(await body(1), "program_officer"));
const s2 = await status(n2);
say(`   v${n2}: status ${s2["status"]}, run ${s2["runState"]}, modelSha ${short(s2["modelSha"])}`);
say(`   gates: ${s2["gates"]["summary"]}`);
expectThat(s2["status"] === "awaiting_officer" && s2["gates"]["canOfficerSign"] === true && s2["gates"]["canClinicianSign"] === false, "officer can sign, clinician still blocked");
const o2 = await sign(n2, "program_officer", OFFICER, s2["modelSha"]);
showSign(`officer signs v${n2}`, o2);
expectThat(o2.status === 201 && o2.body["status"] === "awaiting_clinician", "officer signature recorded; waiting for the clinician");
const k2 = await sign(n2, "clinician", CLINICIAN, s2["modelSha"]);
showSign(`clinician signs v${n2}`, k2);
expectThat(k2.status === 422 && k2.body["error"] === "blocked", `clinician refused with 422: ${(k2.body["blockers"] as Json[] | undefined)?.length ?? 0} open question(s) routed to the clinician`);

heading("The clinician answers their questions (new version 3): signatures start over (AR-04)");
const n3 = await saveVersion(n2, CLINICIAN, "clinician", resolveForDemo(await body(n2), "clinician"));
const s3 = await status(n3);
const s2b = await status(n2);
say(`   v${n2}: status ${s2b["status"]}; its officer signature stays in the history (${(s2b["signatures"] as Json[]).length} stored)`);
say(`   v${n3}: status ${s3["status"]}, ${(s3["signatures"] as Json[]).length} signatures, modelSha ${short(s3["modelSha"])}`);
say(`   gates: ${s3["gates"]["summary"]}`);
expectThat(s2b["status"] === "superseded" && s3["status"] === "awaiting_officer" && (s3["signatures"] as Json[]).length === 0, "old version superseded, new version starts with zero signatures");
const sha3 = s3["modelSha"] as string;
const r1 = await sign(n3, "clinician", CLINICIAN, sha3);
showSign(`clinician signs v${n3} first`, r1);
expectThat(r1.status === 409 && r1.body["error"] === "officer_signature_required", "refused: the officer signs first (AR-03)");
const r2 = await sign(n3, "program_officer", OFFICER, sha3, "clinician");
showSign("officer role sent to the clinician endpoint", r2);
expectThat(r2.status === 403 && r2.body["error"] === "role_mismatch", "refused: role does not match the endpoint");
const o3 = await sign(n3, "program_officer", OFFICER, sha3);
showSign(`officer signs v${n3}`, o3);
expectThat(o3.status === 201, "officer signature recorded");
const r3 = await sign(n3, "clinician", OFFICER, sha3);
showSign(`${OFFICER} tries to sign v${n3} as clinician`, r3);
expectThat(r3.status === 403 && r3.body["error"] === "separation_of_duties", "refused: one person cannot sign both roles");
const r4 = await sign(n3, "clinician", CLINICIAN, s2["modelSha"]);
showSign(`clinician signs v${n3} quoting the sha of v${n2}`, r4);
expectThat(r4.status === 409 && r4.body["error"] === "sha_mismatch", "refused: the signature must name exactly the content being signed (AR-07)");
const k3 = await sign(n3, "clinician", CLINICIAN, sha3);
showSign(`clinician signs v${n3}`, k3);
expectThat(k3.status === 201 && k3.body["status"] === "locked" && k3.body["runState"] === "locked", "version LOCKED and run locked (AR-05)");

heading("Compile: refused for the unlocked version, built for the locked one");
const c2 = await compile(n2);
expectThat(c2.status === "refused", `compile of v${n2} refused (${c2.reason ?? c2.status})`);
const c3 = await compile(n3);
if (c3.status === "cht_skipped") say("   NOTE: cht-conf tooling is not installed (Backend/compile-demo/tools); the CHT project was generated, the cht-conf build was skipped.");
expectThat(c3.status === "pass" || c3.status === "cht_skipped", `compile of v${n3}: ${c3.status}`);
if (c3.manifest) say(`   release build ${c3.manifest.version}, modelSha ${short(c3.manifest.modelSha)} (equals the signed sha: ${c3.manifest.modelSha === sha3})`);
for (const s of c3.cht?.steps ?? []) say(`   cht ${s.action}: ${s.status.toUpperCase()}`);

heading("Edit after lock: a new version (4) with zero signatures; version 3 stays locked and releasable (AR-09)");
const edited = await body(n3);
edited.meta.parent_version = edited.meta.version;
edited.meta.version += 1;
edited.meta.change_note = "TEST-ONLY demo edit after the lock: question wording reviewed.";
edited.questions[0]!.label = `${edited.questions[0]!.label} (reviewed)`;
const n4 = await saveVersion(n3, OFFICER, "program_officer", edited);
const s4 = await status(n4);
const s3b = await status(n3);
say(`   v${n3}: ${s3b["status"]}; v${n4}: ${s4["status"]} with ${(s4["signatures"] as Json[]).length} signatures; latest releasable version: ${s4["latestLocked"]}`);
expectThat(s3b["status"] === "locked" && s4["status"] === "awaiting_officer" && s4["latestLocked"] === n3, "locked version untouched; the edit waits for new signatures");
const c4 = await compile(n4);
expectThat(c4.status === "refused", `compile of v${n4} refused (${c4.reason ?? c4.status})`);

heading("Audit (state changes and signatures)");
for (const a of await store.listAudit(RUN)) {
  if (!["run_state", "signature", "version_locked", "compiled"].includes(a.type)) continue;
  say(`   ${new Date(a.at).toISOString()} ${a.type} ${JSON.stringify(a.detail)}`);
}

// ---------------------------------------------------------------- outputs
const locked = (await store.getVersion(RUN, n3))!;
// The API names saved bodies with a random suffix; blank it so the file is the same on every run.
const lockedOut = { ...locked, artifactKey: locked.artifactKey.replace(/-[0-9a-f-]{36}\.json$/, "-<uuid>.json") };
writeFileSync(path.join(OUT, `locked-v${n3}.json`), `${JSON.stringify({ version: lockedOut, model: await body(n3) }, null, 2)}\n`);
writeFileSync(
  path.join(OUT, "summary.json"),
  `${JSON.stringify(
    {
      runId: RUN,
      finalRunState: (await store.getRun(RUN))!.state,
      versions: await Promise.all([1, n2, n3, n4].map(async (n) => {
        const s = await status(n);
        return { n, status: s["status"], modelSha: s["modelSha"], signatures: s["signatures"], gates: s["gates"] };
      })),
      compile: { [`v${n3}`]: c3.status, refused: [1, n2, n4] },
      problems,
    },
    null,
    2,
  )}\n`,
);
say("");
say(problems.length === 0 ? "Overall: every rule held as expected." : `Overall: ${problems.length} UNEXPECTED result(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
writeFileSync(path.join(OUT, "TRACE.md"), `${trace.join("\n")}\n`);
await api.close();
process.exit(problems.length === 0 ? 0 : 1);
