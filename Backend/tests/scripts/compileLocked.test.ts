import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCompileJob } from "../../scripts/compileLocked.js";
import { demoSettings } from "../compiler/helpers.js";
import { fullyResolved, seed, shaOf } from "../signoff/helpers.js";
import { testInputs } from "../signoff/helpers.js";

const root = mkdtempSync(join(tmpdir(), "compile-job-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("compile job (scripts/compileLocked.ts)", () => {
  it("refuses an unsigned version without touching an earlier build in the output folder", async () => {
    const { store, artifacts } = await seed("awaiting_officer", [fullyResolved()]);
    const out = join(root, "keep");
    mkdirSync(join(out, "project"), { recursive: true });
    writeFileSync(join(out, "project", "earlier.txt"), "an earlier release build");
    const res = await runCompileJob({ store, artifacts, runId: "r1", n: 1, settings: demoSettings(), inputs: async () => testInputs(), outDir: out, log: () => {}, runCht: false });
    expect(res.status).toBe("refused");
    expect(res.reason).toMatch(/not locked/);
    expect(existsSync(join(out, "project", "earlier.txt"))).toBe(true);
  });

  it("builds a locked version and skips cht-conf with a clear reason when asked to (or when it is not installed)", async () => {
    const { store, artifacts, signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.sign("r1", 1, "program_officer", { role: "program_officer", userId: "o1", modelSha: sha });
    await signoff.sign("r1", 1, "clinician", { role: "clinician", userId: "c1", modelSha: sha });
    const out = join(root, "built");
    const res = await runCompileJob({ store, artifacts, runId: "r1", n: 1, settings: demoSettings(), inputs: async () => testInputs(), outDir: out, log: () => {}, runCht: false });
    expect(res.status).toBe("cht_skipped");
    expect(res.reason).toMatch(/cht-conf/);
    expect(res.manifest?.modelSha).toBe(sha);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(existsSync(join(out, "project", "tasks.js"))).toBe(true);
  });
});
