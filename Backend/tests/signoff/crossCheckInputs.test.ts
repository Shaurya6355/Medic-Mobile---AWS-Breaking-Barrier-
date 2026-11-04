import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { crossCheckKey, defaultCheckInputs } from "../../src/signoff/checkInputs.js";
import { computeFindings, inputsShaOf } from "../../src/signoff/checks.js";
import { draftV1, seed, testInputs } from "./helpers.js";

/** The second, independent draft is a check input like the golden cases: it comes with the run, is part of the findings key, and is never required. */
describe("the second draft as a check input", () => {
  it("is read from the run's artifacts first, then from CROSS_CHECK_MODEL_PATH, and is absent otherwise", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "second-draft-"));
    try {
      const file = join(tmp, "second.json");
      writeFileSync(file, JSON.stringify(draftV1()));
      const none = { GOLDEN_CASES_PATH: "none", COMPILE_SETTINGS_PATH: "none" };

      expect((await defaultCheckInputs(new MemoryArtifactStore(), none)("r1")).crossCheck).toBeUndefined();

      const fromEnv = await defaultCheckInputs(new MemoryArtifactStore(), { ...none, CROSS_CHECK_MODEL_PATH: file })("r1");
      expect(fromEnv.crossCheck && "model" in fromEnv.crossCheck).toBe(true);

      const artifacts = new MemoryArtifactStore();
      await artifacts.put(crossCheckKey("r1"), JSON.stringify({ not: "a model" }));
      const fromRun = await defaultCheckInputs(artifacts, { ...none, CROSS_CHECK_MODEL_PATH: file })("r1");
      // The run's own file wins, and a draft that does not parse is kept as invalid so the check can say so.
      expect(fromRun.crossCheck && "invalid" in fromRun.crossCheck).toBe(true);

      expect((await defaultCheckInputs(new MemoryArtifactStore(), { ...none, CROSS_CHECK_MODEL_PATH: "none" })("r1")).crossCheck).toBeUndefined();
      await expect(defaultCheckInputs(new MemoryArtifactStore(), { ...none, CROSS_CHECK_MODEL_PATH: join(tmp, "missing.json") })("r1")).rejects.toThrow(/missing/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("changes the findings key, because it changes what the checks find", () => {
    const without = inputsShaOf(testInputs());
    const a = inputsShaOf({ ...testInputs(), crossCheck: { model: draftV1() } });
    const changed = draftV1();
    changed.scope.age_months_below = 59;
    const b = inputsShaOf({ ...testInputs(), crossCheck: { model: changed } });
    expect(new Set([without, a, b]).size).toBe(3);
    expect(inputsShaOf({ ...testInputs(), crossCheck: { model: draftV1() } })).toBe(a);
  });

  it("reaches the checks end to end: recorded in the context, compared, and never blocking", async () => {
    const plain = await seed("awaiting_officer", [draftV1()]);
    const base = (await computeFindings(plain.signoff.io, "r1", 1)).record;
    expect(base.context.crossCheck).toBe(false);
    expect(base.findings.some((f) => f.check === "crossCheck")).toBe(false);
    // Without a second draft the comparison is skipped, and the findings say so (a skipped check never looks like a pass).
    expect(base.findings.some((f) => f.code === "CONTEXT_NOT_PROVIDED" && String(f.params["needs"]).includes("the second draft"))).toBe(true);

    const second = draftV1();
    second.scope.age_months_below = 59;
    const s = await seed("awaiting_officer", [draftV1()], { inputs: { ...testInputs(), crossCheck: { model: second } } });
    const rec = (await computeFindings(s.signoff.io, "r1", 1)).record;
    expect(rec.context.crossCheck).toBe(true);
    expect(rec.inputsSha).not.toBe(base.inputsSha);
    const mine = rec.findings.filter((f) => f.check === "crossCheck");
    expect(mine.some((f) => f.code === "CROSS_CHECK_SCOPE_DIFFERS")).toBe(true);
    expect(mine.some((f) => f.code === "CROSS_CHECK_SUMMARY")).toBe(true);
    expect(mine.every((f) => f.severity !== "blocking")).toBe(true);
    expect(rec.findings.some((f) => f.code === "CONTEXT_NOT_PROVIDED" && String(f.params["needs"]).includes("the second draft"))).toBe(false);
    expect(rec.blocking).toBe(base.blocking);
    // Both roles see it, worded for them.
    expect(rec.views.clinician.flatMap((g) => g.findings).some((f) => f.code === "CROSS_CHECK_SCOPE_DIFFERS")).toBe(true);
    expect(rec.views.program_officer.flatMap((g) => g.findings).some((f) => f.code === "CROSS_CHECK_SCOPE_DIFFERS")).toBe(true);
  });
});
