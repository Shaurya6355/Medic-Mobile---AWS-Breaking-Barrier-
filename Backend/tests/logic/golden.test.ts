import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/logic/interpreter.js";
import { rawGolden, v1 } from "./helpers.js";

const cases = rawGolden();

describe("proposed golden cases (not clinically confirmed)", () => {
  it("has the expected number of cases with unique ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(14);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = evaluate(v1(), c.answers);
    expect(r.outcome).toBe(c.expected_outcome);
    expect(r.rule).toBe(c.expected_rule);
  });
});
