import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { DEFAULT_GOLDEN_CASES_PATH, defaultCheckInputs } from "../../src/signoff/checkInputs.js";
import { loadGoldenCasesFile, runChecks, withCheckInputs } from "../../src/validation/index.js";
import { demoSettings, matchedCtx, rawGoldenCases } from "./helpers.js";

const file = path.join(import.meta.dirname, "../fixtures/logic/golden-proposed.json");

describe("supplying test cases and form settings to the checks (red team 1, item 8)", () => {
  it("loads and validates a golden-case file", () => {
    const g = loadGoldenCasesFile(file);
    expect(g.length).toBe(20);
    expect(g.map((c) => c.id)).toContain("g16");
  });
  it("adds validated test cases and settings to a context, and the overlap and golden checks then run", () => {
    const ctx = withCheckInputs(matchedCtx(), { goldenCases: rawGoldenCases(), compileSettings: demoSettings() });
    expect(ctx.goldenCases).toHaveLength(20);
    expect(ctx.compileSettings).toBeDefined();
    const codes = runChecks(ctx).findings.map((f) => f.code);
    expect(codes).toContain("GOLDEN_COUNT");
    expect(codes).not.toContain("URGENT_OVERLAP_UNTESTED");
    expect(runChecks(matchedCtx()).findings.map((f) => f.code)).toContain("URGENT_OVERLAP_UNTESTED");
  });
  it("refuses bad test cases and leaves out what is not given", () => {
    expect(() => withCheckInputs(matchedCtx(), { goldenCases: [{ id: "x" }] })).toThrow();
    const ctx = withCheckInputs(matchedCtx(), {});
    expect("goldenCases" in ctx).toBe(false);
    expect("compileSettings" in ctx).toBe(false);
  });
});

describe("default golden cases", () => {
  it("are the 12 Medic-confirmed cases GF01 to GF12, bundled with the image", async () => {
    expect(DEFAULT_GOLDEN_CASES_PATH).toMatch(/golden[\\/]golden-confirmed\.json$/);
    const inputs = await defaultCheckInputs(new MemoryArtifactStore(), {})("any-run");
    expect(inputs.goldenCases?.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => `GF${String(i + 1).padStart(2, "0")}`));
  });
  it("can be switched off with GOLDEN_CASES_PATH=none", async () => {
    expect((await defaultCheckInputs(new MemoryArtifactStore(), { GOLDEN_CASES_PATH: "none" })("any-run")).goldenCases).toBeUndefined();
  });
});
