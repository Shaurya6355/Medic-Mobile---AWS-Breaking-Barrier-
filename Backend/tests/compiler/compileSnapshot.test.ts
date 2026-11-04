import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { modelSha } from "../../src/logic/index.js";
import { ApprovalError, compileSnapshot } from "../../src/compiler/compileSnapshot.js";
import { CompileError } from "../../src/compiler/types.js";
import { readSheets } from "../../src/compiler/xlsx.js";
import { demoSettings, v1 } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "compile-snapshot-"));
let n = 0;
const fresh = () => join(root, `p${n++}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const EXPECTED_FILES = [
  ".eslintrc",
  "README.md",
  "app_settings/base_settings.json",
  "contact-summary.templated.js",
  "forms/app/cough_fast_breathing.properties.json",
  "forms/app/cough_fast_breathing.xlsx",
  "package.json",
  "sourcemap.json",
  "targets.js",
  "tasks.js",
  "translations/messages-en.properties",
];

describe("compileSnapshot (preview) on the v1 fixture", () => {
  it("writes the expected CHT project file set and a manifest that hashes it", async () => {
    const dir = fresh();
    const m = await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    expect(m.files.map((f) => f.path)).toEqual(EXPECTED_FILES);
    for (const f of m.files) {
      const b = readFileSync(join(dir, f.path));
      expect(f.sha256).toBe(sha(b));
      expect(f.bytes).toBe(b.length);
    }
    expect(m.formId).toBe("cough_fast_breathing");
    expect(m.modelSha).toBe(modelSha(v1()));
    expect(m.buildKind).toBe("preview");
    expect(m.version).toBe(`preview-${modelSha(v1()).slice(0, 8)}`);
  });

  it("stamps the preview version in the form and README", async () => {
    const dir = fresh();
    const m = await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    const sheets = await readSheets(readFileSync(join(dir, "forms/app/cough_fast_breathing.xlsx")));
    expect(sheets.settings?.[1]?.[2]).toBe(m.version);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("preview build, not approved, not deployable");
    expect(readme).toContain(m.modelSha);
    expect(readme).toMatch(/separate settings JSON/);
  });

  it("writes tasks.js, targets.js, properties.json and translations", async () => {
    const dir = fresh();
    await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    expect(readFileSync(join(dir, "targets.js"), "utf8")).toBe("module.exports = [];\n");
    expect(readFileSync(join(dir, "tasks.js"), "utf8")).toContain("treat_fast_breathing_at_home-follow-up");
    expect(JSON.parse(readFileSync(join(dir, "forms/app/cough_fast_breathing.properties.json"), "utf8"))).toEqual({
      title: [{ locale: "en", content: "Cough and fast breathing (demo)" }],
      icon: "icon-healthcare",
      context: { person: true, place: false },
    });
    expect(readFileSync(join(dir, "translations/messages-en.properties"), "utf8")).toBe(
      "task.cough_fast_breathing.treat_fast_breathing_at_home.title = Follow up: Fast breathing (pneumonia): treat at home and follow up in 3 days\n",
    );
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).type).toBe("commonjs");
  });

  it("reports warnings and not-compiled items", async () => {
    const m = await compileSnapshot(v1(), { projectDir: fresh(), buildKind: "preview", settings: demoSettings() });
    expect(m.warnings.some((w) => w.startsWith("TEAM_DEFAULT_USED") && w.includes("Q5"))).toBe(true);
    expect(m.notCompiled.map((x) => x.item)).toEqual([
      "outcomes.refer_outside_age_range.follow_up",
      "outcomes.refer_urgent_with_antibiotic.follow_up",
      "outcomes.refer_urgent.follow_up",
    ]);
  });

  it("sourcemap is complete and equals sourcemap.json", async () => {
    const dir = fresh();
    const m = await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    const model = v1();
    const items = new Set(m.sourcemap.entries.map((e) => e.item));
    for (const id of [
      ...model.questions.map((q) => q.id),
      ...model.derived.map((d) => d.id),
      ...model.outcomes.map((o) => o.id),
      ...model.rules.map((r) => r.id),
    ]) {
      expect(items.has(id), id).toBe(true);
    }
    expect(m.sourcemap.entries.filter((e) => e.kind === "task").map((e) => e.item)).toEqual(["treat_fast_breathing_at_home"]);
    expect(JSON.parse(readFileSync(join(dir, "sourcemap.json"), "utf8"))).toEqual(m.sourcemap);
  });

  it("is deterministic: every file has the same sha256 across runs and clocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T08:00:00Z"));
    const a = await compileSnapshot(v1(), { projectDir: fresh(), buildKind: "preview", settings: demoSettings() });
    vi.setSystemTime(new Date("2029-12-31T23:59:59Z"));
    const b = await compileSnapshot(v1(), { projectDir: fresh(), buildKind: "preview", settings: demoSettings() });
    expect(b.files).toEqual(a.files);
  });

  it("refuses a non-empty project directory", async () => {
    const dir = fresh();
    await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    await expect(compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() })).rejects.toThrow(
      /not empty/,
    );
  });
});

describe("compileSnapshot refusals", () => {
  it("missing form title: CompileError with compile_ready false, nothing written", async () => {
    const dir = fresh();
    const err = await compileSnapshot(v1(), {
      projectDir: dir,
      buildKind: "preview",
      settings: demoSettings({ formTitle: "" }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompileError);
    const ce = err as CompileError;
    expect(ce.result.compile_ready).toBe(false);
    expect(ce.result.missing).toEqual(["settings.formTitle"]);
    expect(ce.message).toContain("settings.formTitle");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("null task window without a team default: CompileError naming the field and Q5", async () => {
    const err = await compileSnapshot(v1(), {
      projectDir: fresh(),
      buildKind: "preview",
      settings: demoSettings({ taskWindowDays: undefined }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompileError);
    expect((err as CompileError).result.missing).toEqual([
      "outcomes.treat_fast_breathing_at_home.follow_up.task_window_days_after_due (null and no settings.taskWindowDays; see Q5)",
    ]);
  });

  it("release without approval throws", async () => {
    await expect(
      compileSnapshot(v1(), { projectDir: fresh(), buildKind: "release", settings: demoSettings() }),
    ).rejects.toBeInstanceOf(ApprovalError);
  });

  it("release with a non-matching approval throws, nothing written", async () => {
    const dir = fresh();
    await expect(
      compileSnapshot(v1(), {
        projectDir: dir,
        buildKind: "release",
        settings: demoSettings(),
        approval: { snapshotSha: "0".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ApprovalError);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("release with the matching approval compiles without the preview stamp", async () => {
    const dir = fresh();
    const m = await compileSnapshot(v1(), {
      projectDir: dir,
      buildKind: "release",
      settings: demoSettings(),
      approval: { snapshotSha: modelSha(v1()) },
    });
    expect(m.buildKind).toBe("release");
    expect(m.version).toBe(`release-${m.modelSha.slice(0, 8)}`);
    expect(readFileSync(join(dir, "README.md"), "utf8")).not.toContain("preview build");
  });
});

describe("compileSnapshot writes into an existing empty directory", () => {
  it("accepts an empty directory", async () => {
    const dir = mkdtempSync(join(root, "empty-"));
    const m = await compileSnapshot(v1(), { projectDir: dir, buildKind: "preview", settings: demoSettings() });
    expect(m.files).toHaveLength(EXPECTED_FILES.length);
    writeFileSync(join(root, "marker"), "x");
  });
});
