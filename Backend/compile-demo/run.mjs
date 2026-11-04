// End-to-end compile demo: logic model fixture -> compileSnapshot (preview) -> real cht-conf.
// Run from Backend/:  npm run compile:demo   (runs this file with tsx so it can import the TS sources)
// Writes everything under compile-demo/output/ (see compile-demo/README.md).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel } from "../src/logic/index.js";
import { compileSnapshot } from "../src/compiler/compileSnapshot.js";
import { readSheets } from "../src/compiler/xlsx.js";
import { buildForm, SURVEY_COLUMNS, SURVEY_HEADERS } from "../src/compiler/form.js";
import { FLOW_MODES } from "../src/compiler/types.js";
import { writeFlowOutputs } from "./flow-outputs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "..");
const REPO = resolve(BACKEND, "..");
const OUT = join(HERE, "output");
const PROJECT = join(OUT, "project");
const LOGS = join(OUT, "logs");
const TOOLS = join(HERE, "tools");
const CHT = join(TOOLS, "node_modules", ".bin", "cht");
const ZIPAPP = join(TOOLS, "node_modules", "cht-conf", "bin", "xls2xform-medic");
const SHIM = join(TOOLS, ".pyshim");
const FIXTURE = join(BACKEND, "tests", "fixtures", "logic", "v1.json");
const SETTINGS = join(HERE, "settings.demo.json");
const GOLDEN = join(BACKEND, "tests", "fixtures", "logic", "golden-proposed.json");
const PREVIEW_DIR = join(HERE, "preview");
/** Per-flow-mode verification results (written by compile:verify) survive a recompile. */
const VERIFY_MODES = join(OUT, "verify-modes");
const flowArg = process.argv.find((a) => a.startsWith("--flow="))?.slice("--flow=".length);
if (flowArg !== undefined && !FLOW_MODES.includes(flowArg)) {
  process.stdout.write(`unknown --flow=${flowArg}; use one of ${FLOW_MODES.join(", ")}\n`);
  process.exit(2);
}
/** CHT version assumed for the offline run of validations cht-conf skips without an instance
 *  (deprecated-appearance, deprecated-tel-type): the version of the local cht-core checkout. */
const ASSUMED_CHT_VERSION = "5.3.0";
const CHT_STEPS = ["convert-app-forms", "validate-app-forms", "compile-app-settings"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const tmpRoot = mkdtempSync(join(tmpdir(), "compile-demo-"));
const sanitize = (s) =>
  stripAnsi(s)
    .split(tmpRoot).join("<tmp>")
    .split(REPO).join("<repo>")
    .split(homedir()).join("~");
const rel = (p) => sanitize(p);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------- 0. tools
if (!existsSync(CHT)) {
  log("cht-conf not installed in compile-demo/tools; installing (npm install, pinned cht-conf@6.6.1)...");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: TOOLS, stdio: "inherit" });
  if (r.status !== 0) {
    log("npm install failed in compile-demo/tools");
    process.exit(1);
  }
}
const chtVersion = JSON.parse(readFileSync(join(TOOLS, "node_modules", "cht-conf", "package.json"), "utf8")).version;

const keptVerify = join(tmpRoot, "verify-modes");
if (existsSync(VERIFY_MODES)) cpSync(VERIFY_MODES, keptVerify, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(LOGS, { recursive: true });
if (existsSync(keptVerify)) cpSync(keptVerify, VERIFY_MODES, { recursive: true });

// ---------------------------------------------------------------- 1. compile
const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
const parsed = parseModel(raw);
if (!parsed.ok) {
  log(`fixture does not parse:\n${parsed.issues.join("\n")}`);
  process.exit(1);
}
const model = parsed.value;
const { _note: _ignored, ...settings } = JSON.parse(readFileSync(SETTINGS, "utf8"));
if (flowArg !== undefined) settings.flowMode = flowArg;
settings.flowMode ??= "minimal";
log(`flowMode: ${settings.flowMode}${flowArg !== undefined ? " (from --flow)" : " (from settings.demo.json)"}`);
const manifest = await compileSnapshot(model, { projectDir: PROJECT, buildKind: "preview", settings });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
log(`compiled ${manifest.formId} ${manifest.version}: ${manifest.files.length} files; flow ${manifest.flow.mode}: average ${manifest.flow.avgQuestions.toFixed(2)} questions (all: ${manifest.flow.avgQuestionsFullForm.toFixed(2)}), 0 mismatches required, got ${manifest.flow.compiledMismatches}`);
const flowOut = await writeFlowOutputs({
  model,
  outDir: OUT,
  previewDir: PREVIEW_DIR,
  compiledMode: settings.flowMode,
  golden: JSON.parse(readFileSync(GOLDEN, "utf8")),
  modelSha: manifest.modelSha,
});
log(`flow outputs: output/flow.md, output/flow.html (${flowOut.modes.map((m) => `${m.mode} ${m.avgQuestions.toFixed(2)}`).join(", ")})`);

// ---------------------------------------------------------------- 2. determinism
const second = await compileSnapshot(model, { projectDir: join(tmpRoot, "second"), buildKind: "preview", settings });
const mismatches = [];
const byPath = new Map(second.files.map((f) => [f.path, f]));
for (const f of manifest.files) {
  const g = byPath.get(f.path);
  if (!g) mismatches.push(`${f.path}: missing in second run`);
  else if (g.sha256 !== f.sha256) mismatches.push(`${f.path}: ${f.sha256} != ${g.sha256}`);
}
for (const g of second.files) if (!manifest.files.some((f) => f.path === g.path)) mismatches.push(`${g.path}: only in second run`);
const xlsxPath = `forms/app/${manifest.formId}.xlsx`;
const sheetsA = await readSheets(readFileSync(join(PROJECT, xlsxPath)));
const sheetsB = await readSheets(readFileSync(join(tmpRoot, "second", xlsxPath)));
const sheetsEqual = JSON.stringify(sheetsA) === JSON.stringify(sheetsB);
log(`determinism: ${mismatches.length === 0 ? "all file sha256 identical" : `${mismatches.length} mismatches`}; sheet contents ${sheetsEqual ? "identical" : "DIFFER"}`);

// ---------------------------------------------------------------- 3. python for xls2xform-medic
function which(cmd) {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const candidates = [];
if (process.env.CHT_PYTHON) candidates.push(process.env.CHT_PYTHON);
for (const c of ["python3", "python3.13", "python3.12", "python3.11", "python3.10"]) {
  const p = which(c);
  if (p && !candidates.includes(p)) candidates.push(p);
}
const probes = [];
let python = null;
for (const p of candidates) {
  const v = spawnSync(p, ["--version"], { encoding: "utf8" });
  const version = (v.stdout || v.stderr || "").trim();
  const out = join(tmpRoot, `probe-${probes.length}.xml`);
  const r = spawnSync(p, [ZIPAPP, "--skip_validate", "--json", join(PROJECT, xlsxPath), out], { encoding: "utf8" });
  let ok = false;
  let detail = "";
  try {
    // like cht-conf's exec-promise: the JSON result comes on stdout, or on stderr when stdout is empty
    const last = (r.stdout || r.stderr || "").trim().split("\n").filter(Boolean).at(-1) ?? "";
    const j = JSON.parse(last);
    ok = j.code === 100 || j.code === 101;
    detail = j.message ?? "";
  } catch {
    detail = ((r.stderr || "").trim().split("\n").at(-1) ?? "").slice(0, 200);
  }
  probes.push({ python: p, version, ok, detail });
  log(`python probe ${p} (${version}): ${ok ? "OK" : `FAIL ${detail}`}`);
  if (ok) {
    python = p;
    break;
  }
}

// cht-conf runs bin/xls2xform-medic through its "#!/usr/bin/env python3" shebang. Least invasive
// fix: a private directory holding a python3 symlink to the working interpreter, put first on
// PATH for the cht-conf child processes only. Nothing global changes.
rmSync(SHIM, { recursive: true, force: true });
mkdirSync(SHIM, { recursive: true });
if (python) symlinkSync(python, join(SHIM, "python3"));
const childEnv = { ...process.env, PATH: `${SHIM}:${process.env.PATH ?? ""}`, FORCE_COLOR: "0" };

// cht-conf 6.6.1 runs `${XLS2XFORM} --skip_validate ...` through /bin/sh without escaping the path of its own
// bin/xls2xform-medic (convert-forms/index.js); it only escapes the form paths. When the tools folder path
// contains whitespace (this repo lives under "vs code/"), the shell splits it. Workaround: reach cht-conf
// through a whitespace-free symlink and start node with --preserve-symlinks(-main) so __dirname, and hence
// the XLS2XFORM path, keeps the symlinked spelling. No file of cht-conf is modified.
let chtLauncher = [join(TOOLS, "node_modules", "cht-conf", "src", "bin", "index.js")];
let usedSymlink = null;
if (/\s/.test(TOOLS)) {
  usedSymlink = join(tmpRoot, "cht-tools");
  if (/\s/.test(usedSymlink)) throw new Error(`temp dir has whitespace too: ${usedSymlink}`);
  symlinkSync(TOOLS, usedSymlink);
  chtLauncher = ["--preserve-symlinks", "--preserve-symlinks-main", join(usedSymlink, "node_modules", "cht-conf", "src", "bin", "index.js")];
}
log(`cht-conf launcher: node ${sanitize(chtLauncher.join(" "))}`);

// ---------------------------------------------------------------- 4. cht-conf steps
const steps = [];
let failed = !python;
for (const [i, action] of CHT_STEPS.entries()) {
  const args = [`--source=${PROJECT}`, "--skip-dependency-check", "--skip-version-check", "--skip-git-check", action];
  const logFile = join(LOGS, `${i + 1}-${action}.log`);
  if (failed) {
    writeFileSync(logFile, "skipped: an earlier step failed\n");
    steps.push({ action, status: "skipped", exit: null, log: logFile, errors: [], warnings: [] });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...chtLauncher, ...args], { cwd: PROJECT, env: childEnv, encoding: "utf8" });
  const text = sanitize(
    `$ cht ${args.map((a) => (a.includes(" ") ? `'${a}'` : a)).join(" ")}\n# exit ${r.status} in ${Date.now() - t0} ms\n` +
      `# ---- stdout\n${r.stdout ?? ""}\n# ---- stderr\n${r.stderr ?? ""}`,
  );
  writeFileSync(logFile, text);
  const lines = text.split("\n");
  const errors = lines.filter((l) => /\bERROR\b/.test(l));
  const warnings = lines.filter((l) => /\bWARN\b/.test(l));
  const pass = r.status === 0 && errors.length === 0;
  steps.push({ action, status: pass ? "pass" : "fail", exit: r.status, log: logFile, errors, warnings });
  log(`cht ${action}: ${pass ? "PASS" : "FAIL"} (exit ${r.status}, ${errors.length} errors, ${warnings.length} warnings)`);
  if (!pass) failed = true;
}

// ---------------------------------------------------------------- 5. offline run of instance-only validations
const xmlRel = `forms/app/${manifest.formId}.xml`;
const xmlAbs = join(PROJECT, xmlRel);
const extra = [];
if (existsSync(xmlAbs)) {
  const { createRequire } = await import("node:module");
  const req = createRequire(join(TOOLS, "node_modules", "cht-conf", "package.json"));
  const { DOMParser } = req("@xmldom/xmldom");
  const xmlStr = readFileSync(xmlAbs, "utf8");
  const xmlDoc = new DOMParser().parseFromString(xmlStr);
  for (const name of ["deprecated-appearance", "deprecated-tel-type"]) {
    const v = req(`./src/lib/validation/form/${name}.js`);
    const res = await v.execute({ xformPath: rel(xmlAbs), xmlStr, xmlDoc, apiVersion: ASSUMED_CHT_VERSION, propsData: {} });
    extra.push({ name, errors: res.errors ?? [], warnings: res.warnings ?? [] });
  }
  writeFileSync(
    join(LOGS, "4-offline-instance-validations.log"),
    `# cht-conf validations that need a CHT instance, run directly with apiVersion ${ASSUMED_CHT_VERSION} (assumed)\n` +
      extra.map((e) => `${e.name}: errors=${JSON.stringify(e.errors)} warnings=${JSON.stringify(e.warnings)}`).join("\n") +
      "\n# can-generate-xform needs the CHT API (forms validate endpoint) and was NOT run.\n",
  );
}

// ---------------------------------------------------------------- 6. collect outputs
const appSettingsAbs = join(PROJECT, "app_settings.json");
const outputs = [xmlRel, "app_settings.json"].map((p) => {
  const abs = join(PROJECT, p);
  if (!existsSync(abs)) return { path: p, exists: false };
  const b = readFileSync(abs);
  return { path: p, exists: true, bytes: b.length, sha256: sha256(b) };
});
let appSettingsSummary = null;
if (existsSync(appSettingsAbs)) {
  const a = JSON.parse(readFileSync(appSettingsAbs, "utf8"));
  appSettingsSummary = {
    keys: Object.keys(a).sort(),
    tasksIsDeclarative: a.tasks?.isDeclarative,
    tasksRulesBytes: typeof a.tasks?.rules === "string" ? a.tasks.rules.length : 0,
    targets: a.tasks?.targets,
    contactSummaryBytes: typeof a.contact_summary === "string" ? a.contact_summary.length : 0,
  };
}
let xmlFacts = null;
if (existsSync(xmlAbs)) {
  const x = readFileSync(xmlAbs, "utf8");
  xmlFacts = {
    hasInstanceId: /<instanceID\s*\/>/.test(x),
    hasOutcomeBind: /nodeset="\/[^"]*\/outcome"/.test(x),
    version: (x.match(/version="([^"]+)"/) ?? [])[1] ?? null,
  };
}

const allPass = !!python && steps.every((s) => s.status === "pass") && extra.every((e) => e.errors.length === 0);
const result = {
  status: allPass ? "pass" : "fail",
  flow: manifest.flow,
  chtConfVersion: chtVersion,
  python: { chosen: python, probes },
  chtLauncher: { args: chtLauncher.map(sanitize), whitespaceSymlink: usedSymlink ? sanitize(usedSymlink) : null },
  steps: steps.map((s) => ({ ...s, log: rel(s.log) })),
  extraValidations: extra,
  outputs,
  xmlFacts,
  appSettingsSummary,
  determinism: { fileShaMismatches: mismatches, sheetContentsEqual: sheetsEqual },
};
writeFileSync(join(OUT, "run-result.json"), `${JSON.stringify(result, null, 2)}\n`);

// ---------------------------------------------------------------- 7. REPORT.md and survey.html
const form = buildForm(model, settings, manifest.version);
const fl = manifest.flow;
const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const mdTable = (headers, rows) =>
  [`| ${headers.map(mdCell).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`)].join("\n");
const tail = (file, n = 25) => {
  const t = readFileSync(file, "utf8").trimEnd().split("\n");
  return t.slice(-n).join("\n");
};
const fence = (lang, s) => `\`\`\`${lang}\n${s.trimEnd()}\n\`\`\``;

const report = [];
report.push(
  "# Compile demo report",
  "",
  `Model: \`${model.meta.pathway_id}\` v${model.meta.version} (fixture \`Backend/tests/fixtures/logic/v1.json\`)  `,
  `modelSha: \`${manifest.modelSha}\`  `,
  `Build: **${manifest.buildKind}**, form version \`${manifest.version}\`: preview build, not approved, not deployable.  `,
  `cht-conf: ${chtVersion} (npm, compile-demo/tools). Python for xls2xform-medic: ${python ? `\`${rel(python)}\`` : "NONE FOUND"}.  `,
  `Overall: **${allPass ? "PASS" : "FAIL"}**`,
  "",
  "Synthetic data only. The settings used (`compile-demo/settings.demo.json`) are demo placeholders.",
  "",
  "## 0. Question flow",
  "",
  `flowMode: **${fl.mode}** (flow derivation version \`${fl.derivationVersion}\`). Average questions asked over the ${fl.points}-combination grid: **${fl.avgQuestions.toFixed(2)}** (all questions: ${fl.avgQuestionsFullForm.toFixed(2)}).`,
  fl.mode === "full"
    ? "No derived flow: every question its authored shown_when allows is asked."
    : `Flow tree: ${fl.nodes} nodes, ${fl.leaves} leaves. Always asked: ${fl.questionsAlwaysAsked.join(", ") || "none"}. Sometimes skipped: ${fl.questionsSometimesSkipped.join(", ") || "none"}. Never asked: ${fl.neverAsked.join(", ") || "none"}. verifyFlow before emitting: ${fl.treeMismatches} tree / ${fl.compiledMismatches} compiled mismatches, ${fl.sequenceDifferences} sequence differences (the compile refuses on any mismatch).`,
  "Diagram and plain sentences for minimal and danger_signs_always: [flow.md](flow.md), [flow.html](flow.html) (offline).",
  fl.mode === "minimal"
    ? "The minimal flow never asks danger-sign questions of a child outside the age range (the outcome is already decided); `--flow=danger_signs_always` asks them always. The clinician chooses."
    : "",
  "",
  "## 1. What was compiled (compileSnapshot manifest)",
  "",
  mdTable(["file", "bytes", "sha256"], manifest.files.map((f) => [`project/${f.path}`, f.bytes, `\`${f.sha256}\``])),
  "",
  "Files added by cht-conf:",
  "",
  mdTable(
    ["file", "bytes", "sha256"],
    outputs.map((o) => [`project/${o.path}`, o.exists ? o.bytes : "MISSING", o.exists ? `\`${o.sha256}\`` : ""]),
  ),
  "",
  `- Generated XForm: \`compile-demo/output/project/${xmlRel}\`${xmlFacts ? ` (instanceID present: ${xmlFacts.hasInstanceId}, outcome bind present: ${xmlFacts.hasOutcomeBind})` : ""}`,
  "- Compiled app settings: `compile-demo/output/project/app_settings.json`" +
    (appSettingsSummary
      ? ` (tasks.isDeclarative: ${appSettingsSummary.tasksIsDeclarative}, compiled task rules ${appSettingsSummary.tasksRulesBytes} chars, targets ${JSON.stringify(appSettingsSummary.targets)})`
      : ""),
  "- Source XLSForm: `compile-demo/output/project/" + xlsxPath + "`",
  "- Sourcemap (row/task -> model item and {page, quote}): `compile-demo/output/project/sourcemap.json`",
  "- Browser view of the survey: `compile-demo/output/survey.html`",
  "",
  "## 2. cht-conf steps",
  "",
  "Run in this order: convert-app-forms (xlsx -> XForm via xls2xform-medic), validate-app-forms (reads the XForm, so it",
  "must follow convert, as in cht-conf's own default action order), compile-app-settings (tasks.js, targets.js,",
  "contact summary, base settings -> app_settings.json). Flags: `--source=<project> --skip-dependency-check",
  "--skip-version-check --skip-git-check <action>`; no `--local`/`--url`, so no CouchDB is needed.",
  "",
  mdTable(
    ["step", "result", "exit", "errors", "warnings", "log"],
    steps.map((s) => [s.action, s.status.toUpperCase(), s.exit ?? "", s.errors.length, s.warnings.length, `\`${rel(s.log).replace(/^<repo>\/Backend\//, "")}\``]),
  ),
  "",
);
for (const s of steps) {
  report.push(`### ${s.action}: ${s.status.toUpperCase()}`, "", fence("text", tail(s.log)), "");
}
report.push(
  "### Validations cht-conf skips without a CHT instance",
  "",
  "validate-app-forms ran has-instance-id, no-required-notes, check-xpaths-exist, db-doc-is-valid, db-doc-ref-is-valid and",
  "validate-field-paths. It skipped deprecated-appearance, deprecated-tel-type and can-generate-xform because they need an instance.",
  `The first two only need a version number, so this run also executed them directly with apiVersion ${ASSUMED_CHT_VERSION}`,
  "(assumed: the local cht-core checkout version). can-generate-xform posts the form to the CHT API and was NOT run.",
  "",
  mdTable(["validation", "errors", "warnings"], extra.map((e) => [e.name, e.errors.length ? e.errors.join("; ") : "0", e.warnings.length ? e.warnings.join("; ") : "0"])),
  "",
  "## 3. Survey sheet",
  "",
  mdTable(SURVEY_COLUMNS.map((c) => SURVEY_HEADERS[c]), form.survey.map((r) => SURVEY_COLUMNS.map((c) => r[c] ?? ""))),
  "",
  "## 4. Choices sheet",
  "",
  mdTable(["list_name", "name", "label::en"], form.choices.map((c) => [c.list_name, c.name, c.label])),
  "",
  "Settings sheet: " + mdTable(Object.keys(form.settings), [Object.values(form.settings)]).replace(/^/, "\n\n"),
  "",
  "## 5. Generated tasks.js",
  "",
  fence("js", readFileSync(join(PROJECT, "tasks.js"), "utf8")),
  "",
  "## 6. Generated properties.json",
  "",
  fence("json", readFileSync(join(PROJECT, `forms/app/${manifest.formId}.properties.json`), "utf8")),
  "",
  "## 7. Not compiled and warnings",
  "",
  mdTable(["item", "reason"], manifest.notCompiled.map((n) => [n.item, n.reason])),
  "",
  ...manifest.warnings.map((w) => `- ${w}`),
  "",
  "Note: `refer_urgent_with_antibiotic` and `refer_urgent` carry due_in_days 7 but kind `on_return`; per the compiler rules",
  "on_return follow-ups are not turned into tasks until a return trigger is defined.",
  "",
  "## 8. Determinism",
  "",
  mismatches.length === 0
    ? `Compiled twice (second run in a temp directory): all ${manifest.files.length} generated files have identical sha256, including the .xlsx.`
    : `Compiled twice: ${mismatches.length} sha256 mismatches:\n\n${mismatches.map((m) => `- ${m}`).join("\n")}`,
  `Sheet contents read back from both .xlsx files: ${sheetsEqual ? "identical" : "DIFFERENT"}.`,
  "How: exceljs stamps zip entries with the current time, so the compiler fixes workbook creator/created/modified and",
  "re-packs the zip with JSZip giving every entry the same fixed date (byte-level determinism, not just sheet equality).",
  "The cht-conf outputs (XForm, app_settings.json) are not part of this comparison.",
  "",
  "## 9. Not yet verified",
  "",
  "- compile:demo alone does not fill the form: `npm run compile:verify` does (golden cases in the UI, edit scenarios, the",
  "  differential grid against the interpreter in the CHT enketo engine); its result is linked below once it has run.",
  "- tasks.js and targets behaviour are not exercised (needs cht-conf-test-harness).",
  "- No round-trip parse-back (XForm or xlsx -> logic model) has been done.",
  "- Not approved, not signed: this is a preview build and must not be deployed.",
  "- can-generate-xform (CHT API form validation) was not run: there is no CHT instance.",
  "- Demo settings (form title, icon, 7-day task window for Q5, contact types) are placeholders, not decisions.",
  "- Open questions Q1 to Q6 in the model are still open; the compiled logic reflects the current draft answers.",
  "",
);
writeFileSync(join(OUT, "REPORT.md"), report.join("\n"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let depth = 0;
const htmlRows = form.survey
  .map((r, i) => {
    if (r.type === "end group") depth = Math.max(0, depth - 1);
    const pad = depth;
    if (r.type === "begin group") depth++;
    const cls = r.type.replace(/[^a-z]+/g, "-");
    return `<tr class="${cls}"><td>${i + 2}</td><td style="padding-left:${0.5 + pad * 1.5}em">${esc(r.type)}</td><td><code>${esc(r.name)}</code></td><td>${esc(r.label).replace(/\n/g, "<br>")}</td><td>${esc(r.required)}</td><td><code>${esc(r.relevant)}</code></td><td><code>${esc(r.constraint)}</code>${r.constraint_message ? `<br><small>${esc(r.constraint_message)}</small>` : ""}</td><td><code>${esc(r.calculation)}</code></td></tr>`;
  })
  .join("\n");
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(settings.formTitle)}: survey preview</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5em;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}
th{background:#f0f0f0;position:sticky;top:0}
code{font-size:12px;white-space:pre-wrap;word-break:break-word}
tr.begin-group td,tr.end-group td{background:#eef3fb}
tr.calculate td{background:#fbf7ea}
tr.note td{background:#eefbef}
.banner{background:#fff3cd;border:1px solid #e0c060;padding:8px;margin-bottom:1em}
</style></head><body>
<div class="banner"><strong>preview build, not approved, not deployable.</strong> Form <code>${esc(manifest.formId)}</code> version <code>${esc(manifest.version)}</code>, modelSha <code>${esc(manifest.modelSha)}</code>. Synthetic demo; settings are placeholders.</div>
<h1>${esc(settings.formTitle)}</h1>
<p>Survey rows in order (row = worksheet row in <code>forms/app/${esc(manifest.formId)}.xlsx</code>). Choices: yes_no = yes (Yes), no (No).</p>
<table><thead><tr><th>row</th><th>type</th><th>name</th><th>label</th><th>required</th><th>relevant</th><th>constraint</th><th>calculation</th></tr></thead>
<tbody>
${htmlRows}
</tbody></table>
</body></html>
`;
writeFileSync(join(OUT, "survey.html"), html);

rmSync(tmpRoot, { recursive: true, force: true });
log(`\nOverall: ${allPass ? "PASS" : "FAIL"}`);
log(`Report: ${rel(join(OUT, "REPORT.md"))}`);
log(`Survey: ${rel(join(OUT, "survey.html"))}`);
process.exit(allPass ? 0 : 1);
