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

  it("warns when the rule for out-of-range ages does not match the scope", () => {
    const fs = run((m) => { m.scope.age_months_min = 3; });
    expect(fs.map((f) => f.code)).toEqual(["SCOPE_RULE_MISMATCH"]);
    expect(fs[0]!.severity).toBe("warning");
    expect(fs[0]!.message).toContain("2 months");
    expect(codes((m) => { m.rules[0].when.any[1].value = 59; })).toEqual(["SCOPE_RULE_MISMATCH"]);
  });

  it("does not warn about scope when there is no age-only rule", () => {
    expect(run((m) => { m.rules[0].when = { field: "cough", op: "is_yes" }; })).toEqual([]);
  });

  it("is deterministic and de-duplicated", () => {
    const m = (x: any) => { x.rules[2].outcome = "nope"; x.derived[0].id = "cough"; };
    expect(run(m).map((f) => f.id)).toEqual(run(m).map((f) => f.id));
  });
});
