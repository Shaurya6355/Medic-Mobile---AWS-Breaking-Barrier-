import { describe, expect, it } from "vitest";
import { fieldNames, RESERVED_FIELD_NAMES } from "../../src/validation/checks/fieldNames.js";
import { matchedCtx, v1Copy } from "./helpers.js";

const run = (mutate?: (m: any) => void, deployed?: (m: any) => void) => {
  const ctx = matchedCtx(mutate);
  return fieldNames(deployed === undefined ? ctx : { ...ctx, deployed: v1Copy(deployed) });
};

describe("fieldNames", () => {
  it("v1.json has safe names that are not reserved", () => {
    expect(run()).toEqual([]);
  });
  it("lists the names the form builder and the health platform keep for themselves", () => {
    for (const n of ["outcome", "source", "source_id", "contact", "inputs", "meta", "data", "patient_id", "patient_uuid", "patient_name", "instanceID", "results"]) {
      expect(RESERVED_FIELD_NAMES, n).toContain(n.toLowerCase());
    }
  });
  it("blocks a question named like a reserved name", () => {
    const fs = run((m) => { m.questions[1].id = "inputs"; m.derived[0].definition.all[0].field = "inputs"; });
    const f = fs.find((x) => x.code === "RESERVED_FIELD_NAME" && x.subjects[0]!.id === "inputs")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("program_officer");
    expect(f.message).toContain("inputs");
  });
  it("blocks a calculated value named outcome (case does not matter for the platform)", () => {
    const fs = run((m) => { m.derived[0].id = "outcome"; });
    expect(fs.map((f) => f.code)).toContain("RESERVED_FIELD_NAME");
    const g = run((m) => { m.derived[0].id = "instanceID"; });
    expect(g.map((f) => f.code)).toContain("RESERVED_FIELD_NAME");
  });
  it("blocks names starting with outcome_ and q_ collisions with the screens the builder creates", () => {
    expect(run((m) => { m.derived[0].id = "outcome_refer"; }).map((f) => f.code)).toContain("RESERVED_FIELD_NAME");
    expect(run((m) => { m.derived[0].id = "q_cough"; }).map((f) => f.code)).toContain("RESERVED_FIELD_NAME");
    expect(run((m) => { m.derived[0].id = "q_nothing_like_it"; })).toEqual([]);
  });
  it("blocks names that are too long or not safe for a form", () => {
    const long = "a".repeat(33);
    const fs = run((m) => { m.derived[0].id = long; });
    const f = fs.find((x) => x.code === "INVALID_FIELD_NAME")!;
    expect(f.severity).toBe("blocking");
    expect(f.message).toContain("32");
    expect(run((m) => { m.derived[0].id = "a".repeat(32); })).toEqual([]);
    const bad = run((m) => { m.derived[0].id = "Fast-Breathing"; });
    expect(bad.map((x) => x.code)).toContain("INVALID_FIELD_NAME");
    expect(run((m) => { m.derived[0].id = "1abc"; }).map((x) => x.code)).toContain("INVALID_FIELD_NAME");
  });
  it("without a deployed version there is no rename check", () => {
    expect(run().some((f) => f.code === "FIELD_RENAMED")).toBe(false);
  });
  it("a question that exists in the deployed version and is gone or renamed blocks, once for each person who must confirm", () => {
    const fs = run((m) => { m.questions[1].id = "has_cough"; m.derived[0].definition.all[0].field = "has_cough"; m.derived[1].definition.any[0].all[0].field = "has_cough"; m.questions[2].shown_when.field = "has_cough"; m.questions[7].shown_when.field = "has_cough"; m.rules[4].when.field = "has_cough"; }, () => {});
    const r = fs.filter((f) => f.code === "FIELD_RENAMED");
    expect(r.map((f) => f.decidedBy).sort()).toEqual(["clinician", "program_officer"]);
    for (const f of r) {
      expect(f.severity).toBe("blocking");
      expect(f.subjects).toEqual([{ kind: "question", id: "cough" }]);
      expect(f.audience).toEqual([f.decidedBy]);
      expect(f.message).toContain("existing reports");
    }
  });
  it("a calculated value that disappeared is reported too; a new field is not", () => {
    const fs = run((m) => { m.derived.pop(); m.rules = m.rules.filter((r: any) => true); }, undefined);
    expect(fs).toEqual([]);
    const ctx = matchedCtx((m) => { m.derived = m.derived.filter((d: any) => d.id !== "danger_sign"); });
    const out = fieldNames({ ...ctx, deployed: v1Copy() });
    expect(out.filter((f) => f.code === "FIELD_RENAMED").every((f) => f.subjects[0]!.kind === "derived" && f.subjects[0]!.id === "danger_sign")).toBe(true);
    const added = fieldNames({ ...matchedCtx(), deployed: v1Copy((m) => { m.questions.pop(); m.questions.pop(); }) });
    expect(added.some((f) => f.code === "FIELD_RENAMED")).toBe(false);
  });
});

describe("fieldNames: built-in object property names (red team 1, M73, M92)", () => {
  it("reserves constructor, prototype and the other names every object already has", async () => {
    const { fieldNames: fn, RESERVED_FIELD_NAMES: names } = await import("../../src/validation/checks/fieldNames.js");
    const { matchedCtx: ctx } = await import("./helpers.js");
    for (const id of ["constructor", "prototype", "hasownproperty", "tostring", "valueof"]) expect(names).toContain(id);
    const fs = fn(ctx((m) => { m.questions[8].id = "constructor"; }));
    const f = fs.find((x) => x.code === "RESERVED_FIELD_NAME")!;
    expect(f.severity).toBe("blocking");
    expect(f.message).toContain("constructor");
  });
});
