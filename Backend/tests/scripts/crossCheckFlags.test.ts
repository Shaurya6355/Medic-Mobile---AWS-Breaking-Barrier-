import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crossCheckFlags } from "../../scripts/crossCheckFlags.js";

const v1 = (): any => JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "fixtures", "logic", "v1.json"), "utf8"));
const changeCutoff = (m: any, from: number, to: number): void => {
  const walk = (c: any): void => {
    if ("field" in c) {
      if (c.value === from) c.value = to;
    } else for (const k of c.all ?? c.any) walk(k);
  };
  for (const d of m.derived) walk(d.definition);
};
const second = (mutate: (m: any) => void): any => {
  const m = v1();
  mutate(m);
  return m;
};

describe("crossCheckFlags (what compare_outputs.py stores in flags.json)", () => {
  it("two identical logic models give one information flag and no warning", () => {
    const r = crossCheckFlags(v1(), v1());
    if (!r.ok) throw new Error("expected ok");
    expect(r.flags.map((f) => f.code)).toEqual(["CROSS_CHECK_SUMMARY"]);
    expect(r.summary).toMatchObject({ flagCount: 1, bySeverity: { blocking: 0, warning: 0, info: 1 }, differing: 0 });
    expect(r.summary.compared).toBeGreaterThan(1000);
  });

  it("turns a difference into flags a person can read, for each role, all open and none blocking", () => {
    const r = crossCheckFlags(v1(), second((m) => changeCutoff(m, 50, 40)));
    if (!r.ok) throw new Error("expected ok");
    const cut = r.flags.find((f) => f.code === "CROSS_CHECK_CUTOFF_DIFFERS");
    expect(cut).toBeDefined();
    expect(cut?.messages.clinician).toContain("The clinician decides");
    expect(cut?.messages.program_officer).toContain("The program officer asks the clinician");
    expect(r.flags.some((f) => f.code === "CROSS_CHECK_DISAGREEMENT")).toBe(true);
    expect(r.flags.every((f) => f.status === "open" && f.severity !== "blocking" && f.decidedBy === "clinician")).toBe(true);
    expect(r.summary.differing).toBeGreaterThan(0);
    expect(r.summary.byCode["CROSS_CHECK_CUTOFF_DIFFERS"]).toBe(1);
  });

  it("lists warnings before information, and gives the same flags in the same order every time", () => {
    const run = () => crossCheckFlags(v1(), second((m) => changeCutoff(m, 50, 40)));
    const a = run();
    const b = run();
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.flags.map((f) => f.id)).toEqual(b.flags.map((f) => f.id));
    const ranks = a.flags.map((f) => ({ warning: 0, info: 1 })[f.severity as "warning" | "info"]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(a.flags[a.flags.length - 1]?.code).toBe("CROSS_CHECK_SUMMARY");
  });

  it("says plainly when the first logic model is not valid, and flags a second one that cannot be read", () => {
    const bad = crossCheckFlags({ not: "a model" }, v1());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0);
    const r = crossCheckFlags(v1(), { not: "a model" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.flags.map((f) => f.code)).toEqual(["CROSS_CHECK_SECOND_DRAFT_INVALID"]);
  });
});
