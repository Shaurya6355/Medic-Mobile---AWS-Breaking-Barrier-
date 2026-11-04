import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { artifactKey } from "../../src/artifacts/artifactStore.js";
import { ApprovalError } from "../../src/compiler/compileSnapshot.js";
import { compileLockedVersion } from "../../src/compiler/compileLocked.js";
import { settingsShaOf } from "../../src/signoff/checks.js";
import { fullyResolved, seed, shaOf } from "../signoff/helpers.js";
import { testInputs } from "../signoff/helpers.js";
import { demoSettings } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "compile-locked-"));
let i = 0;
const fresh = () => join(root, `p${i++}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const empty = (d: string) => !existsSync(d) || readdirSync(d).length === 0;

async function locked(signers: "none" | "officer" | "both") {
  const s = await seed("awaiting_officer", [fullyResolved()]);
  const sha = shaOf(fullyResolved());
  if (signers !== "none") await s.signoff.signAsAgent("r1", 1, sha);
  if (signers === "both") await s.signoff.sign("r1", 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha });
  return { ...s, sha };
}

describe("compileLockedVersion (AR-08: only a version with both signatures is built)", () => {
  it("refuses an unsigned version and writes nothing", async () => {
    const { store, artifacts } = await locked("none");
    const dir = fresh();
    await expect(compileLockedVersion({ store, artifacts, runId: "r1", n: 1, projectDir: dir, settings: demoSettings(), inputs: async () => testInputs() })).rejects.toBeInstanceOf(ApprovalError);
    expect(empty(dir)).toBe(true);
  });

  it("refuses a version signed only by the officer", async () => {
    const { store, artifacts } = await locked("officer");
    const dir = fresh();
    await expect(compileLockedVersion({ store, artifacts, runId: "r1", n: 1, projectDir: dir, settings: demoSettings(), inputs: async () => testInputs() })).rejects.toThrow(/not locked/);
    expect(empty(dir)).toBe(true);
  });

  it("refuses an unknown version", async () => {
    const { store, artifacts } = await locked("both");
    await expect(compileLockedVersion({ store, artifacts, runId: "r1", n: 4, projectDir: fresh(), settings: demoSettings(), inputs: async () => testInputs() })).rejects.toBeInstanceOf(ApprovalError);
  });

  it("builds a locked version as a release, stores the manifest and records it", async () => {
    const { store, artifacts, sha } = await locked("both");
    const dir = fresh();
    const res = await compileLockedVersion({ store, artifacts, runId: "r1", n: 1, projectDir: dir, settings: demoSettings(), inputs: async () => testInputs() });
    expect(res.manifest.buildKind).toBe("release");
    expect(res.manifest.modelSha).toBe(sha);
    expect(existsSync(join(dir, "forms", "app", `${res.manifest.formId}.xlsx`))).toBe(true);
    expect(res.manifestKey).toBe(artifactKey("r1", "compile", sha, settingsShaOf(demoSettings()), "manifest.json"));
    expect(await artifacts.exists(res.manifestKey)).toBe(true);
    expect((await store.listAudit("r1")).some((a) => a.type === "compiled")).toBe(true);
  });
});
