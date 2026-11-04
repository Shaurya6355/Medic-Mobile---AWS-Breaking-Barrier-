import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/logic/interpreter.js";
import { goldenCasesCheck } from "../../src/validation/checks/goldenCases.js";
import { loadGoldenCases } from "../../src/validation/context.js";
import { rawGolden, v1 } from "./helpers.js";

// golden-testcases.json = the 20 proposed cases (g01 to g20, golden-proposed.json) followed by the 12
// Medic-confirmed cases GF01 to GF12 from golden-cases-final-12-annotated.xlsx.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "logic");
const raw = JSON.parse(readFileSync(join(fixtures, "golden-testcases.json"), "utf8"));
const cases = loadGoldenCases(raw);
const confirmedIds = Array.from({ length: 12 }, (_, i) => `GF${String(i + 1).padStart(2, "0")}`);
const confirmed = cases.filter((c) => c.id.startsWith("GF"));

describe("golden-testcases.json (merged golden cases)", () => {
  it("is the proposed cases unchanged, followed by GF01 to GF12", () => {
    const proposed = rawGolden();
    expect(raw.slice(0, proposed.length)).toEqual(proposed);
    expect(raw.slice(proposed.length).map((c: { id: string }) => c.id)).toEqual(confirmedIds);
    expect(cases).toHaveLength(proposed.length + 12);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s gets its expected outcome through its expected rule", (_id, c) => {
    const r = evaluate(v1(), c.answers);
    expect(r.outcome).toBe(c.expected_outcome);
    expect(r.rule).toBe(c.expected_rule);
  });

  it("marks GF01 to GF12 as Medic confirmed, not pending", () => {
    for (const c of confirmed) {
      expect(c.note).toMatch(/^Medic confirmed/);
      expect(c.note).not.toMatch(/pending|awaiting|not (?:yet )?(?:clinically )?confirmed/i);
    }
  });

  it("passes the golden case check: every case agrees and every outcome is covered", () => {
    const findings = goldenCasesCheck({ model: v1(), goldenCases: cases } as Parameters<typeof goldenCasesCheck>[0]);
    expect(findings.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain("OUTCOME_WITHOUT_GOLDEN_CASE");
    const count = findings.find((f) => f.code === "GOLDEN_COUNT");
    expect(count?.params).toMatchObject({ total: cases.length, agree: cases.length, different: 0 });
  });
});
