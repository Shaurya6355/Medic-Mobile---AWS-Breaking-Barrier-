/**
 * Drives the real cht-conf over a generated CHT project: picks a Python that can run cht-conf's
 * xls2xform-medic, works around the unquoted-path bug for paths with spaces, runs convert-app-forms,
 * validate-app-forms and compile-app-settings, then runs offline the two instance-only validations that
 * only need a version number. Shared by compile-demo/run.mjs, scripts/compileLocked.ts and the pipeline
 * demo, so there is one copy of this logic. Build-host code (DEC-014): never imported from src/.
 * See compile-demo/README.md for why each workaround exists.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPILE_DEMO_DIR = dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = join(COMPILE_DEMO_DIR, "tools");
/** CHT version assumed for the offline run of validations cht-conf skips without an instance (local cht-core checkout). */
export const ASSUMED_CHT_VERSION = "5.3.0";
export const CHT_STEPS = ["convert-app-forms", "validate-app-forms", "compile-app-settings"] as const;

const chtBin = (tools: string): string => join(tools, "node_modules", ".bin", "cht");
const chtPackage = (tools: string): string => join(tools, "node_modules", "cht-conf", "package.json");

/** True when cht-conf is installed in compile-demo/tools (git-ignored node_modules). */
export function chtToolsInstalled(tools: string = TOOLS_DIR): boolean {
  return existsSync(chtBin(tools)) && existsSync(chtPackage(tools));
}

/** npm install in the tools folder (network needed once). Returns false when it fails. */
export function installChtTools(tools: string = TOOLS_DIR): boolean {
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: tools, stdio: "inherit" });
  return r.status === 0;
}

export function chtConfVersion(tools: string = TOOLS_DIR): string {
  return (JSON.parse(readFileSync(chtPackage(tools), "utf8")) as { version: string }).version;
}

export interface PythonProbe {
  python: string;
  version: string;
  ok: boolean;
  detail: string;
}

export interface ChtStepResult {
  action: string;
  status: "pass" | "fail" | "skipped";
  exit: number | null;
  log: string;
  errors: string[];
  warnings: string[];
}

export interface ExtraValidation {
  name: string;
  errors: string[];
  warnings: string[];
}

export interface ChtRunResult {
  chtConfVersion: string;
  python: { chosen: string | null; probes: PythonProbe[] };
  launcher: { args: string[]; whitespaceSymlink: string | null };
  steps: ChtStepResult[];
  extraValidations: ExtraValidation[];
  /** Every cht-conf step passed and the offline validations found no error. */
  allPass: boolean;
}

export interface RunChtConfOptions {
  projectDir: string;
  logsDir: string;
  formId: string;
  /** A private temp dir without whitespace (probe outputs and the whitespace-free symlink go here). */
  tmpRoot: string;
  /** Strips temp, repo and home paths from logged text. */
  sanitize: (s: string) => string;
  log: (msg: string) => void;
  tools?: string;
  assumedChtVersion?: string;
}

function which(cmd: string): string | null {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function runChtConf(opts: RunChtConfOptions): Promise<ChtRunResult> {
  const tools = opts.tools ?? TOOLS_DIR;
  const assumed = opts.assumedChtVersion ?? ASSUMED_CHT_VERSION;
  const { projectDir, logsDir, formId, tmpRoot, sanitize, log } = opts;
  const zipapp = join(tools, "node_modules", "cht-conf", "bin", "xls2xform-medic");
  const shim = join(tools, ".pyshim");
  const xlsxPath = `forms/app/${formId}.xlsx`;
  mkdirSync(logsDir, { recursive: true });

  // ---- python for xls2xform-medic: the first candidate that really converts the generated xlsx
  const candidates: string[] = [];
  if (process.env["CHT_PYTHON"]) candidates.push(process.env["CHT_PYTHON"]);
  for (const c of ["python3", "python3.13", "python3.12", "python3.11", "python3.10"]) {
    const p = which(c);
    if (p && !candidates.includes(p)) candidates.push(p);
  }
  const probes: PythonProbe[] = [];
  let python: string | null = null;
  for (const p of candidates) {
    const v = spawnSync(p, ["--version"], { encoding: "utf8" });
    const version = (v.stdout || v.stderr || "").trim();
    const out = join(tmpRoot, `probe-${probes.length}.xml`);
    const r = spawnSync(p, [zipapp, "--skip_validate", "--json", join(projectDir, xlsxPath), out], { encoding: "utf8" });
    let ok = false;
    let detail = "";
    try {
      // like cht-conf's exec-promise: the JSON result comes on stdout, or on stderr when stdout is empty
      const last = (r.stdout || r.stderr || "").trim().split("\n").filter(Boolean).at(-1) ?? "";
      const j = JSON.parse(last) as { code?: number; message?: string };
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

  // cht-conf runs bin/xls2xform-medic through its "#!/usr/bin/env python3" shebang: a private directory
  // with a python3 symlink to the working interpreter goes first on PATH for the cht-conf children only.
  rmSync(shim, { recursive: true, force: true });
  mkdirSync(shim, { recursive: true });
  if (python) symlinkSync(python, join(shim, "python3"));
  const childEnv = { ...process.env, PATH: `${shim}:${process.env["PATH"] ?? ""}`, FORCE_COLOR: "0" };

  // cht-conf 6.6.1 does not quote the path of its own bin/xls2xform-medic; reach it through a
  // whitespace-free symlink with --preserve-symlinks(-main) when the tools path has whitespace.
  let launcher = [join(tools, "node_modules", "cht-conf", "src", "bin", "index.js")];
  let usedSymlink: string | null = null;
  if (/\s/.test(tools)) {
    usedSymlink = join(tmpRoot, "cht-tools");
    if (/\s/.test(usedSymlink)) throw new Error(`temp dir has whitespace too: ${usedSymlink}`);
    symlinkSync(tools, usedSymlink);
    launcher = ["--preserve-symlinks", "--preserve-symlinks-main", join(usedSymlink, "node_modules", "cht-conf", "src", "bin", "index.js")];
  }
  log(`cht-conf launcher: node ${sanitize(launcher.join(" "))}`);

  // ---- cht-conf steps
  const steps: ChtStepResult[] = [];
  let failed = !python;
  for (const [i, action] of CHT_STEPS.entries()) {
    const args = [`--source=${projectDir}`, "--skip-dependency-check", "--skip-version-check", "--skip-git-check", action];
    const logFile = join(logsDir, `${i + 1}-${action}.log`);
    if (failed) {
      writeFileSync(logFile, "skipped: an earlier step failed\n");
      steps.push({ action, status: "skipped", exit: null, log: logFile, errors: [], warnings: [] });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [...launcher, ...args], { cwd: projectDir, env: childEnv, encoding: "utf8" });
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

  // ---- offline run of the instance-only validations that need only a version number
  const xmlAbs = join(projectDir, `forms/app/${formId}.xml`);
  const extra: ExtraValidation[] = [];
  if (existsSync(xmlAbs)) {
    const req = createRequire(chtPackage(tools));
    const { DOMParser } = req("@xmldom/xmldom") as { DOMParser: new () => { parseFromString(s: string): unknown } };
    const xmlStr = readFileSync(xmlAbs, "utf8");
    const xmlDoc = new DOMParser().parseFromString(xmlStr);
    for (const name of ["deprecated-appearance", "deprecated-tel-type"]) {
      const v = req(`./src/lib/validation/form/${name}.js`) as {
        execute(a: unknown): Promise<{ errors?: string[]; warnings?: string[] }>;
      };
      const res = await v.execute({ xformPath: sanitize(xmlAbs), xmlStr, xmlDoc, apiVersion: assumed, propsData: {} });
      extra.push({ name, errors: res.errors ?? [], warnings: res.warnings ?? [] });
    }
    writeFileSync(
      join(logsDir, "4-offline-instance-validations.log"),
      `# cht-conf validations that need a CHT instance, run directly with apiVersion ${assumed} (assumed)\n` +
        extra.map((e) => `${e.name}: errors=${JSON.stringify(e.errors)} warnings=${JSON.stringify(e.warnings)}`).join("\n") +
        "\n# can-generate-xform needs the CHT API (forms validate endpoint) and was NOT run.\n",
    );
  }

  const allPass = !!python && steps.every((s) => s.status === "pass") && extra.every((e) => e.errors.length === 0);
  return {
    chtConfVersion: chtConfVersion(tools),
    python: { chosen: python, probes },
    launcher: { args: launcher.map(sanitize), whitespaceSymlink: usedSymlink ? sanitize(usedSymlink) : null },
    steps,
    extraValidations: extra,
    allPass,
  };
}
