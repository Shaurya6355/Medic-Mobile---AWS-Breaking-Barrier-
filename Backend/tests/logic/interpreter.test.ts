import { describe, expect, it } from "vitest";
import {
  AnswerError,
  DerivedCycleError,
  EvalError,
  MissingRequiredError,
  allMatches,
  effectiveAnswers,
  evalCondition,
  evaluate,
} from "../../src/logic/interpreter.js";
import { parseModel } from "../../src/logic/schema.js";
import { rawV1, v1 } from "./helpers.js";

const base = {
  age_months: 24,
  cough: false,
  convulsions: false,
  not_able_to_drink_or_feed: false,
  vomits_everything: false,
  chest_indrawing: false,
  unusually_sleepy: false,
};
const m = v1();

describe("effectiveAnswers", () => {
  it("drops answers for hidden questions even when supplied", () => {
    const e = effectiveAnswers(m, { ...base, cough_days: 99999, breaths_per_minute: 55 });
    expect(e.cough_days).toBeUndefined();
    expect(e.breaths_per_minute).toBeUndefined();
  });
  it("keeps shown answers", () => {
    const e = effectiveAnswers(m, { ...base, cough: true, cough_days: 3, breaths_per_minute: 55 });
    expect(e.cough_days).toBe(3);
  });
  it("rejects unknown keys, wrong types, non-integers, NaN, constraint violations (all listed)", () => {
    try {
      effectiveAnswers(m, {
        ...base,
        age_months: 2.5,
        cough: "yes" as never,
        bogus: 1 as never,
        convulsions: NaN as never,
        vomits_everything: 3 as never,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AnswerError);
      const issues = (e as AnswerError).issues.join("\n");
      expect(issues).toContain("bogus");
      expect(issues).toContain("age_months");
      expect(issues).toContain("cough");
      expect(issues).toContain("convulsions");
      expect(issues).toContain("vomits_everything");
    }
  });
  it("rejects integer outside constraint and infinity", () => {
    expect(() => effectiveAnswers(m, { ...base, age_months: 121 })).toThrow(AnswerError);
    expect(() => effectiveAnswers(m, { ...base, age_months: -1 })).toThrow(AnswerError);
    expect(() => effectiveAnswers(m, { ...base, age_months: Infinity })).toThrow(AnswerError);
    expect(() => effectiveAnswers(m, { ...base, cough: true, cough_days: 3, breaths_per_minute: 9 })).toThrow(AnswerError);
  });
  it("throws MissingRequiredError listing ids when a shown required question is missing", () => {
    try {
      effectiveAnswers(m, { age_months: 5, cough: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRequiredError);
      expect((e as MissingRequiredError).ids).toEqual([
        "cough_days",
        "convulsions",
        "not_able_to_drink_or_feed",
        "vomits_everything",
        "chest_indrawing",
        "breaths_per_minute",
        "unusually_sleepy",
      ]);
    }
  });
  it("does not require hidden questions", () => {
    expect(() => effectiveAnswers(m, base)).not.toThrow();
  });
  it("allowMissing lets shown questions stay absent", () => {
    const e = effectiveAnswers(m, { cough: true }, { allowMissing: true });
    expect(e.age_months).toBeUndefined();
  });
});

describe("evalCondition", () => {
  const known = new Set(["a", "b"]);
  it("is_yes true only for boolean true", () => {
    expect(evalCondition({ field: "a", op: "is_yes" }, { a: true }, known)).toBe(true);
    expect(evalCondition({ field: "a", op: "is_yes" }, { a: false }, known)).toBe(false);
    expect(evalCondition({ field: "a", op: "is_yes" }, { a: 1 }, known)).toBe(false);
    expect(evalCondition({ field: "a", op: "is_yes" }, {}, known)).toBe(false);
  });
  it("absent makes comparisons false, including less_than", () => {
    expect(evalCondition({ field: "a", op: "at_least", value: 1 }, {}, known)).toBe(false);
    expect(evalCondition({ field: "a", op: "less_than", value: 1 }, {}, known)).toBe(false);
    expect(evalCondition({ field: "a", op: "less_than", value: 1 }, { a: 0 }, known)).toBe(true);
    expect(evalCondition({ field: "a", op: "at_least", value: 1 }, { a: 1 }, known)).toBe(true);
  });
  it("comparison on a boolean value is false", () => {
    expect(evalCondition({ field: "a", op: "at_least", value: 0 }, { a: true }, known)).toBe(false);
  });
  it("all and any", () => {
    const t = { field: "a", op: "is_yes" } as const;
    const f = { field: "b", op: "is_yes" } as const;
    const v = { a: true, b: false };
    expect(evalCondition({ all: [t, f] }, v, known)).toBe(false);
    expect(evalCondition({ any: [t, f] }, v, known)).toBe(true);
    expect(evalCondition({ all: [t, t] }, v, known)).toBe(true);
    expect(evalCondition({ any: [f, f] }, v, known)).toBe(false);
  });
  it("unknown field throws EvalError with path, even behind a short circuit", () => {
    const c = { any: [{ field: "a", op: "is_yes" }, { field: "zzz", op: "is_yes" }] } as const;
    try {
      evalCondition(c as never, { a: true }, known, "rules[3].when");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError);
      expect((e as Error).message).toContain("rules[3].when.any[1]");
      expect((e as Error).message).toContain("zzz");
    }
  });
});

describe("evaluate", () => {
  it("returns outcome, severity, rule, derived, effective and a trace stopping at first match", () => {
    const r = evaluate(m, { ...base, age_months: 6, cough: true, cough_days: 3, breaths_per_minute: 52 });
    expect(r.outcome).toBe("treat_fast_breathing_at_home");
    expect(r.severity).toBe(3);
    expect(r.rule).toBe("R5");
    expect(r.derived).toEqual({ outside_age_range: false, fast_breathing: true, danger_sign: false });
    expect(r.trace.map((t) => [t.rule, t.priority, t.matched])).toEqual([
      ["R1", 1, false],
      ["R2", 2, false],
      ["R3", 3, false],
      ["R4", 4, false],
      ["R5", 5, true],
    ]);
    expect(r.trace[4]!.reads).toEqual({ fast_breathing: true });
  });
  it("trace reads show absent", () => {
    const r = evaluate(m, base);
    expect(r.rule).toBe("R7");
    expect(r.trace[0]!.reads).toEqual({ outside_age_range: false, danger_sign: false });
    expect(r.trace[5]!.reads).toEqual({ cough: false });
    const r2 = evaluate(m, { ...base, cough: true, cough_days: 1, breaths_per_minute: 20 });
    expect(r2.rule).toBe("R6");
  });
  it("otherwise always matches", () => {
    expect(evaluate(m, base).outcome).toBe("no_cough");
  });
  it("allMatches lists every matching rule in priority order", () => {
    expect(allMatches(m, { ...base, age_months: 1, convulsions: true })).toEqual(["R1", "R2", "R4", "R7"]);
  });
  it("a child under 2 months with convulsions gets R1 (urgent referral, severity 1), not the lower-severity out-of-range rule R2", () => {
    const r = evaluate(m, { ...base, age_months: 1, convulsions: true });
    expect(r.rule).toBe("R1");
    expect(r.outcome).toBe("refer_urgent_outside_age_range");
    expect(r.severity).toBe(1);
  });
  it("evaluates rules in ascending priority regardless of array order", () => {
    const raw = rawV1();
    raw.rules.reverse();
    const p = parseModel(raw);
    expect(p.ok && evaluate(p.value, { ...base, age_months: 1, convulsions: true }).rule).toBe("R1");
  });
  it("derived may read other derived, in dependency order", () => {
    const raw = rawV1();
    raw.derived.unshift({
      id: "chain",
      label: "chain",
      definition: { all: [{ field: "danger_sign", op: "is_yes" }, { field: "fast_breathing", op: "is_yes" }] },
      origin: "team",
    });
    const p = parseModel(raw);
    if (!p.ok) throw new Error(p.issues.join());
    const r = evaluate(p.value, { ...base, age_months: 24, cough: true, cough_days: 14, breaths_per_minute: 45 });
    expect(r.derived).toEqual({ chain: true, outside_age_range: false, fast_breathing: true, danger_sign: true });
  });
  it("derived cycle throws DerivedCycleError", () => {
    const raw = rawV1();
    raw.derived[1].definition = { field: "danger_sign", op: "is_yes" };
    raw.derived[2].definition = { field: "fast_breathing", op: "is_yes" };
    const p = parseModel(raw);
    if (!p.ok) throw new Error(p.issues.join());
    expect(() => evaluate(p.value, base)).toThrow(DerivedCycleError);
  });
  it("is deterministic", () => {
    const a = JSON.stringify(evaluate(m, { ...base, age_months: 3, chest_indrawing: true }));
    const b = JSON.stringify(evaluate(m, { ...base, age_months: 3, chest_indrawing: true }));
    expect(a).toBe(b);
  });
});

describe("answers named like built-in object properties (red team 1, M92)", () => {
  // The schema now rejects such ids; the interpreter must still never read inherited properties.
  const withCtor = (): any => {
    const raw = JSON.parse(JSON.stringify(rawV1()).split('"unusually_sleepy"').join('"constructor"'));
    const r = parseModel(rawV1());
    if (!r.ok) throw new Error("fixture");
    const mm: any = structuredClone(r.value);
    const conv = JSON.parse(JSON.stringify(mm).split('"unusually_sleepy"').join('"constructor"'));
    conv.questions.find((q: any) => q.id === "constructor").shown_when = { field: "cough", op: "is_yes" };
    void raw;
    return conv;
  };
  it("a question that was not asked counts as not answered, not as the inherited property", () => {
    const mm = withCtor();
    const { unusually_sleepy: _u, ...rest } = base;
    void _u;
    const e = evaluate(mm, { ...rest }, { allowMissing: true });
    expect(e.outcome).toBe("no_cough");
    expect(evalCondition({ field: "constructor", op: "is_yes" }, {}, new Set(["constructor"]))).toBe(false);
    expect(evalCondition({ field: "toString", op: "is_yes" }, {}, new Set(["toString"]))).toBe(false);
  });
  it("an answer object with a prototype is only read for its own keys", () => {
    const mm = withCtor();
    const { unusually_sleepy: _u, ...rest } = base;
    void _u;
    const answers = Object.assign(Object.create({ constructor: true }), rest);
    expect(effectiveAnswers(mm, answers, { allowMissing: true })["constructor"]).toBeUndefined();
  });
});
