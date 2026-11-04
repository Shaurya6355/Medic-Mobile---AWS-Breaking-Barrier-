import { describe, expect, it } from "vitest";
import { parseModel } from "../../src/logic/schema.js";
import { collectFieldRefs } from "../../src/logic/schema.js";
import { issuesOf, rawV1, v1 } from "./helpers.js";

describe("parseModel on v1.json", () => {
  it("parses the golden reference as given", () => {
    const r = parseModel(rawV1());
    expect(r.ok).toBe(true);
  });

  it("normalises a single source to an array", () => {
    const m = v1();
    expect(m.questions[0]!.source).toEqual([{ page: 3, quote: "child age 2 months up to 5 years" }]);
    expect(m.scope.source).toEqual([{ page: 3, quote: "child age 2 months up to 5 years" }]);
  });

  it("accepts an array of sources and keeps it", () => {
    const raw = rawV1();
    raw.derived[0].source = [
      { page: 8, quote: "a" },
      { page: 8, quote: "b" },
    ];
    const r = parseModel(raw);
    expect(r.ok && r.value.derived[0]!.source).toHaveLength(2);
  });

  it("collectFieldRefs lists every field once in order", () => {
    const m = v1();
    expect(collectFieldRefs(m.rules[1]!.when as never)).toEqual(["danger_sign", "fast_breathing", "chest_indrawing"]);
    expect(collectFieldRefs(m.derived[0]!.definition)).toEqual(["cough", "age_months", "breaths_per_minute"]);
  });
});

describe("parseModel rejects structural errors", () => {
  const mutate = (fn: (m: any) => void): string[] => {
    const raw = rawV1();
    fn(raw);
    return issuesOf(raw);
  };

  it("not an object", () => {
    expect(parseModel(42).ok).toBe(false);
    expect(parseModel(null).ok).toBe(false);
  });
  it("unknown key (top level, question, condition)", () => {
    expect(mutate((m) => (m.extra = 1)).length).toBeGreaterThan(0);
    expect(mutate((m) => (m.questions[0].extra = 1)).join()).toContain("questions[0]");
    expect(mutate((m) => (m.rules[2].when.extra = 1)).join()).toContain("rules[2]");
  });
  it("bad op", () => {
    expect(mutate((m) => (m.rules[2].when.op = "equals")).join()).toContain("rules[2].when");
  });
  it("missing otherwise", () => {
    expect(mutate((m) => (m.rules[5].when = { field: "cough", op: "is_yes" })).join()).toContain("otherwise");
  });
  it("two otherwise", () => {
    expect(mutate((m) => (m.rules[4].when = "otherwise")).join()).toContain("otherwise");
  });
  it("otherwise not the highest priority", () => {
    expect(
      mutate((m) => {
        m.rules[5].priority = 1;
        m.rules[0].priority = 6;
      }).join(),
    ).toContain("otherwise");
  });
  it("duplicate priority", () => {
    expect(mutate((m) => (m.rules[1].priority = 1)).join()).toContain("priority");
  });
  it("duplicate or descending question order", () => {
    expect(mutate((m) => (m.questions[1].order = 1)).join()).toContain("order");
    expect(mutate((m) => (m.questions[1].order = 0)).join()).toContain("order");
  });
  it("origin guideline without source", () => {
    expect(mutate((m) => delete m.questions[1].source).join()).toContain("questions[1]");
  });
  it("origin team may omit source", () => {
    expect(mutate((m) => delete m.outcomes[4].source)).toEqual([]);
  });
  it("integer constraint min > max", () => {
    expect(mutate((m) => (m.questions[0].constraint.min = 500)).join()).toContain("constraint");
  });
  it("constraint on yes_no", () => {
    expect(mutate((m) => (m.questions[1].constraint = { min: 0, max: 1, message: "x", origin: "team" })).join()).toContain(
      "constraint",
    );
  });
  it("is_yes with a value", () => {
    expect(mutate((m) => (m.rules[2].when.value = 3)).length).toBeGreaterThan(0);
  });
  it("at_least without value", () => {
    expect(mutate((m) => (m.derived[1].definition.any[0].all[1] = { field: "cough_days", op: "at_least" })).length).toBeGreaterThan(0);
  });
  it("non-finite value", () => {
    const raw = rawV1();
    raw.derived[1].definition.any[0].all[1].value = Number.POSITIVE_INFINITY;
    expect(issuesOf(raw).length).toBeGreaterThan(0);
  });
  it("bad sha", () => {
    expect(mutate((m) => (m.meta.guideline.file_sha256 = "abc")).join()).toContain("meta.guideline.file_sha256");
  });
  it("empty or blank quote", () => {
    expect(mutate((m) => (m.questions[0].source.quote = "")).length).toBeGreaterThan(0);
    expect(mutate((m) => (m.questions[0].source.quote = "   ")).length).toBeGreaterThan(0);
  });
  it("page below 1", () => {
    expect(mutate((m) => (m.questions[0].source.page = 0)).length).toBeGreaterThan(0);
  });
  it("wrong schema_version", () => {
    expect(mutate((m) => (m.schema_version = "2.0")).join()).toContain("schema_version");
  });
  it("bad id pattern, severity range, empty actions, bad hit_policy", () => {
    expect(mutate((m) => (m.questions[0].id = "Age")).join()).toContain("questions[0].id");
    expect(mutate((m) => (m.outcomes[0].severity = 10)).join()).toContain("outcomes[0].severity");
    expect(mutate((m) => (m.outcomes[0].actions = [])).join()).toContain("outcomes[0].actions");
    expect(mutate((m) => (m.hit_policy = "collect")).join()).toContain("hit_policy");
  });
  it("empty all/any", () => {
    expect(mutate((m) => (m.rules[0].when = { any: [] })).length).toBeGreaterThan(0);
  });
  it("bad created_at", () => {
    expect(mutate((m) => (m.meta.created_at = "yesterday")).join()).toContain("meta.created_at");
  });
  it("resolved status needs nothing, bad route_to rejected", () => {
    expect(mutate((m) => (m.open_questions[0].route_to = "nobody")).join()).toContain("open_questions[0]");
  });
  it("accepts nesting at the limit and rejects beyond it", () => {
    const nest = (n: number): unknown => {
      let c: unknown = { field: "cough", op: "is_yes" };
      for (let i = 0; i < n; i++) c = { all: [c] };
      return c;
    };
    const ok = rawV1();
    ok.rules[2].when = nest(31);
    expect(issuesOf(ok)).toEqual([]);
    const bad = rawV1();
    bad.rules[2].when = nest(33);
    expect(issuesOf(bad).join()).toContain("nesting");
  });
  it("rejects very deep nesting and cycles without overflow", () => {
    const raw = rawV1();
    let c: any = { field: "cough", op: "is_yes" };
    for (let i = 0; i < 100000; i++) c = { any: [c] };
    raw.rules[2].when = c;
    expect(issuesOf(raw).join()).toContain("nesting");
    const cyc = rawV1();
    const loop: any = { all: [] };
    loop.all.push(loop);
    cyc.derived[0].definition = loop;
    expect(issuesOf(cyc).join()).toContain("nesting");
  });
});
