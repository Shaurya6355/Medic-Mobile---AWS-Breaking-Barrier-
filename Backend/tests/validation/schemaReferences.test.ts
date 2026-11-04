import { describe, expect, it } from "vitest";
import { schemaReferences } from "../../src/validation/checks/schemaReferences.js";
import { realCtx } from "./helpers.js";

const run = (mutate?: (m: any) => void) => schemaReferences(realCtx(mutate));
const codes = (mutate?: (m: any) => void) => run(mutate).map((f) => f.code);

describe("schemaReferences on v1.json", () => {
  it("passes the reference model", () => {
    expect(run()).toEqual([]);
  });

  it("flags a structure the schema rejects: an unknown field", () => {
    const fs = run((m) => { m.questions[0].colour = "red"; });
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((f) => f.code === "SCHEMA_INVALID" && f.severity === "blocking")).toBe(true);
    expect(fs[0]!.params["path"]).toContain("questions[0]");
  });

  it("flags severity outside 1..9 as invalid", () => {
    expect(codes((m) => { m.outcomes[0].severity = 10; })).toContain("SCHEMA_INVALID");
    expect(codes((m) => { m.outcomes[0].severity = 0; })).toContain("SCHEMA_INVALID");
  });

  it("flags a duplicate id across questions, calculated values, results, rules and open questions", () => {
    const a = run((m) => { m.derived[0].id = "cough"; });
    expect(a.map((f) => f.code)).toContain("DUPLICATE_ID");
    const dup = a.find((f) => f.code === "DUPLICATE_ID")!;
    expect(dup.params["id"]).toBe("cough");
    expect(dup.params["kinds"]).toBe("calculated value, question");
    expect(codes((m) => { m.questions[2].id = "cough"; })).toContain("DUPLICATE_ID");
    expect(codes((m) => { m.rules[1].id = "R1"; })).toContain("DUPLICATE_ID");
    expect(codes((m) => { m.open_questions[1].id = "Q1"; })).toContain("DUPLICATE_ID");
    expect(codes((m) => { m.outcomes[1].id = "refer_urgent"; })).toContain("DUPLICATE_ID");
    expect(codes((m) => { m.rules[1].id = "refer_urgent"; })).toContain("DUPLICATE_ID");
  });

  it("flags an unknown field read by a condition, naming where", () => {
    const fs = run((m) => { m.rules[2].when = { field: "temperature", op: "at_least", value: 38 }; });
    expect(fs.map((f) => f.code)).toEqual(["UNKNOWN_VARIABLE"]);
    expect(fs[0]!.params["variable"]).toBe("temperature");
    expect(fs[0]!.subjects).toEqual([{ kind: "rule", id: "R3" }]);
    expect(codes((m) => { m.derived[1].definition.any[1].field = "nope"; })).toEqual(["UNKNOWN_VARIABLE"]);
    expect(codes((m) => { m.questions[2].shown_when.field = "nope"; })).toEqual(["UNKNOWN_VARIABLE"]);
  });

  it("flags a rule that points to an unknown result", () => {
    const fs = run((m) => { m.rules[2].outcome = "refer_to_mars"; });
    expect(fs.map((f) => f.code)).toEqual(["UNKNOWN_OUTCOME"]);
    expect(fs[0]!.params["outcome"]).toBe("refer_to_mars");
  });

  it("flags operator misuse: yes test on a number, number test on a yes/no question or calculated value", () => {
    const yesOnNumber = run((m) => { m.rules[0].when = { field: "age_months", op: "is_yes" }; });
    expect(yesOnNumber.map((f) => f.code)).toContain("OPERATOR_MISUSE");
    expect(yesOnNumber.find((f) => f.code === "OPERATOR_MISUSE")!.message).toContain("number");
    expect(codes((m) => { m.rules[4].when = { field: "cough", op: "at_least", value: 1 }; })).toEqual(["OPERATOR_MISUSE"]);
    expect(codes((m) => { m.rules[2].when = { field: "danger_sign", op: "less_than", value: 1 }; })).toEqual(["OPERATOR_MISUSE"]);
  });

  it("flags a fractional value compared with a whole-number question as a type mismatch", () => {
    const fs = run((m) => { m.rules[0].when.any[0].value = 2.5; });
    expect(fs.map((f) => f.code)).toContain("TYPE_MISMATCH");
  });

  it("lets a calculated value be tested with is_yes inside conditions", () => {
    expect(run((m) => { m.rules[1].when.all[0] = { field: "fast_breathing", op: "is_yes" }; })).toEqual([]);
  });

  it("flags a shown_when that reads a calculated value, a later question or itself", () => {
    expect(codes((m) => { m.questions[2].shown_when = { field: "danger_sign", op: "is_yes" }; })).toEqual(["RELEVANCE_READS_DERIVED"]);
    expect(codes((m) => { m.questions[2].shown_when = { field: "convulsions", op: "is_yes" }; })).toEqual(["RELEVANCE_READS_LATER_QUESTION"]);
    expect(codes((m) => { m.questions[2].shown_when = { field: "cough_days", op: "at_least", value: 1 }; })).toEqual(["RELEVANCE_READS_LATER_QUESTION"]);
  });

  it("flags a calculated value that depends on itself, directly or in a circle", () => {
    const self = run((m) => { m.derived[1].definition = { any: [{ field: "danger_sign", op: "is_yes" }, { field: "cough", op: "is_yes" }] }; });
    expect(self.map((f) => f.code)).toEqual(["DERIVED_CYCLE"]);
    const circle = run((m) => {
      m.derived[0].definition = { field: "danger_sign", op: "is_yes" };
      m.derived[1].definition = { field: "fast_breathing", op: "is_yes" };
    });
    expect(circle.map((f) => f.code)).toEqual(["DERIVED_CYCLE", "DERIVED_CYCLE"]);
    // reading another calculated value without a circle is fine
    expect(run((m) => { m.derived[1].definition = { any: [{ field: "fast_breathing", op: "is_yes" }, { field: "cough", op: "is_yes" }] }; })).toEqual([]);
  });

  it("flags an open question that affects an unknown item", () => {
    const fs = run((m) => { m.open_questions[0].affects = ["fast_breathing", "ghost"]; });
    expect(fs.map((f) => f.code)).toEqual(["UNKNOWN_AFFECTED_ITEM"]);
    expect(fs[0]!.params["target"]).toBe("ghost");
    expect(run((m) => { m.open_questions[0].affects = ["R3", "refer_urgent", "age_months", "danger_sign"]; })).toEqual([]);
  });

  it("blocks when the rule for out-of-range ages does not match the scope (red team 1, M28, M66)", () => {
    const fs = run((m) => { m.scope.age_months_min = 3; });
    expect(fs.map((f) => f.code)).toEqual(["SCOPE_RULE_MISMATCH"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.decidedBy).toBe("clinician");
    expect(fs[0]!.message).toContain("2 months");
    expect(codes((m) => { m.rules[0].when.any[1].value = 59; })).toEqual(["SCOPE_RULE_MISMATCH"]);
    // R1 "less than 1 month" leaves 1-month-olds in the cough flow
    expect(run((m) => { m.rules[0].when.any[0].value = 1; }).map((f) => [f.code, f.severity])).toEqual([["SCOPE_RULE_MISMATCH", "blocking"]]);
    // -0 removes the lower bound altogether
    expect(codes((m) => { m.rules[0].when.any[0].value = -0; })).toEqual(["SCOPE_RULE_MISMATCH"]);
  });

  it("checks the rule against every cut-off it uses, not only the edges of the range", () => {
    const fs = run((m) => { m.rules[0].when.any.push({ all: [{ field: "age_months", op: "at_least", value: 30 }, { field: "age_months", op: "less_than", value: 31 }] }); });
    expect(fs.map((f) => f.code)).toEqual(["SCOPE_RULE_MISMATCH"]);
    expect(fs[0]!.message).toContain("30 months");
  });

  it("several age-only rules together may cover the ages outside the range", () => {
    expect(run((m) => {
      m.rules[0].when = { field: "age_months", op: "less_than", value: 2 };
      m.rules.splice(1, 0, { id: "R1b", priority: 7, when: { field: "age_months", op: "at_least", value: 60 }, outcome: "refer_outside_age_range", origin: "team" });
      m.rules.sort((a: any, b: any) => a.priority - b.priority);
      m.rules.find((r: any) => r.when === "otherwise").priority = 8;
      m.rules.sort((a: any, b: any) => a.priority - b.priority);
    })).toEqual([]);
  });

  it("a rule through a calculated value that reads only the age counts as the out-of-range rule", () => {
    expect(run((m) => {
      m.derived.push({ id: "outside_age", label: "Outside the covered ages", definition: m.rules[0].when, origin: "team" });
      m.rules[0].when = { field: "outside_age", op: "is_yes" };
    })).toEqual([]);
  });

  it("blocks when no rule handles children outside the covered ages and such ages can be entered (red team 1, M27b)", () => {
    const fs = run((m) => { m.rules[0].when = { field: "cough", op: "is_yes" }; });
    expect(fs.map((f) => f.code)).toEqual(["SCOPE_RULE_MISSING"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.message).toContain("2 up to 60 months");
    // when the entry limits only allow the covered ages, no such rule is needed
    expect(run((m) => {
      m.rules[0].when = { field: "cough", op: "is_yes" };
      m.questions[0].constraint.min = 2;
      m.questions[0].constraint.max = 59;
    })).toEqual([]);
  });

  it("is deterministic and de-duplicated", () => {
    const m = (x: any) => { x.rules[2].outcome = "nope"; x.derived[0].id = "cough"; };
    expect(run(m).map((f) => f.id)).toEqual(run(m).map((f) => f.id));
  });
});
