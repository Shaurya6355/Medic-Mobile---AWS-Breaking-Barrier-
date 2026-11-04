import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/logic/canonical.js";
import {
  dangerSignQuestions,
  deriveFlow,
  describeFlow,
  describeFlowByOutcome,
  effectiveShownWhen,
  evalFlowCondition,
  FLOW_DERIVATION_VERSION,
  flowToMermaid,
  FlowTooLargeError,
  verifyFlow,
  walkFlow,
  type Flow,
  type FlowCondition,
  type FlowNode,
} from "../../src/logic/flow.js";
import { evaluate, type Answers } from "../../src/logic/interpreter.js";
import { parseModel, type Model } from "../../src/logic/schema.js";
import { rawV1, v1 } from "./helpers.js";

const m = v1();
const flow = deriveFlow(m);
const safe = deriveFlow(m, { askAllDangerSigns: true });

const DANGER = [
  "cough",
  "cough_days",
  "convulsions",
  "not_able_to_drink_or_feed",
  "vomits_everything",
  "chest_indrawing",
  "unusually_sleepy",
];

/** A child in range with every yes/no answer "no" unless overridden. */
function child(over: Answers): Answers {
  const base: Answers = {
    age_months: 6,
    cough: false,
    convulsions: false,
    not_able_to_drink_or_feed: false,
    vomits_everything: false,
    chest_indrawing: false,
    unusually_sleepy: false,
  };
  const out: Answers = { ...base, ...over };
  if (out.cough === true) {
    out.cough_days ??= 3;
    out.breaths_per_minute ??= 30;
  }
  return out;
}

function parse(raw: unknown): Model {
  const r = parseModel(raw);
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.value;
}

/** Minimal valid model wrapper for hand-made shapes. */
function tiny(parts: { questions: unknown[]; derived?: unknown[]; outcomes: string[]; rules: unknown[] }): Model {
  const raw = rawV1();
  raw.questions = parts.questions;
  raw.derived = parts.derived ?? [];
  raw.outcomes = parts.outcomes.map((id, i) => ({
    id,
    severity: i + 1,
    title: `Outcome ${id}`,
    actions: [{ text: "Do it.", origin: "team" }],
    follow_up: null,
    origin: "team",
  }));
  raw.rules = parts.rules;
  raw.open_questions = [];
  return parse(raw);
}

const q = (id: string, order: number, type: "integer" | "yes_no", extra: object = {}): object => ({
  id,
  order,
  label: `Question ${id}?`,
  answer_type: type,
  required: true,
  origin: "team",
  ...(type === "integer" ? { constraint: { min: 0, max: 50, message: "Enter a number.", origin: "team" } } : {}),
  ...extra,
});

describe("deriveFlow on v1: tree shape", () => {
  it("starts by asking age, which splits into four age regions that each go on to ask about cough", () => {
    const root = flow.root;
    expect("ask" in root && root.ask).toBe("age_months");
    if (!("ask" in root)) throw new Error("root is a leaf");
    expect(root.branches.map((b) => b.region)).toEqual([
      { kind: "range", min: null, below: 2 },
      { kind: "range", min: 2, below: 12 },
      { kind: "range", min: 12, below: 60 },
      { kind: "range", min: 60, below: null },
    ]);
    // Under the final model an out-of-range child is still asked the danger signs: R1 (urgent) beats R2.
    for (const b of root.branches) expect("ask" in b.next && b.next.ask).toBe("cough");
  });

  it("age and cough are asked on every path; every other question is sometimes skipped; none unreachable", () => {
    expect(flow.stats.questionsAlwaysAsked).toEqual(["age_months", "cough"]);
    expect(flow.stats.questionsSometimesSkipped).toEqual(m.questions.map((x) => x.id).filter((id) => id !== "age_months" && id !== "cough"));
    expect(flow.stats.neverAsked).toEqual([]);
    expect(flow.stats.maxDepth).toBe(9);
    expect(flow.stats.leaves).toBeGreaterThan(4);
    expect(flow.stats.nodes).toBeGreaterThan(flow.stats.leaves);
  });

  it("breaths are split at 50 for 2 to 11 months and at 40 for 12 to 59 months (adjacent equal regions merged)", () => {
    const regionsFor = (age: number): unknown[] => {
      const found = new Set<string>();
      const visit = (n: FlowNode): void => {
        if (!("ask" in n)) return;
        if (n.ask === "breaths_per_minute") found.add(canonicalJson(n.branches.map((b) => b.region)));
        for (const b of n.branches) visit(b.next);
      };
      if (!("ask" in flow.root)) throw new Error("leaf");
      const br = flow.root.branches.find((b) => b.region.kind === "range" && b.region.min !== null && b.region.min <= age && (b.region.below === null || age < b.region.below));
      visit(br!.next);
      return [...found].map((s) => JSON.parse(s));
    };
    for (const r of regionsFor(6)) {
      expect(r).toEqual([
        { kind: "range", min: null, below: 50 },
        { kind: "range", min: 50, below: null },
      ]);
    }
    for (const r of regionsFor(30)) {
      expect(r).toEqual([
        { kind: "range", min: null, below: 40 },
        { kind: "range", min: 40, below: null },
      ]);
    }
  });
});

describe("deriveFlow on v1: what is asked, in order, for typical children", () => {
  it("age out of range with a danger sign: age, cough, convulsions, then refer urgently (R1)", () => {
    const w = walkFlow(flow, child({ age_months: 1, convulsions: true }));
    expect(w.asked).toEqual(["age_months", "cough", "convulsions"]);
    expect(w.leaf).toEqual({ leaf: "refer_urgent_outside_age_range", rule: "R1" });
  });
  it("age out of range with no danger sign: every danger-sign question is asked, then refer (R2)", () => {
    const w = walkFlow(flow, child({ age_months: 1 }));
    expect(w.asked).toEqual([
      "age_months",
      "cough",
      "convulsions",
      "not_able_to_drink_or_feed",
      "vomits_everything",
      "chest_indrawing",
      "unusually_sleepy",
    ]);
    expect(w.leaf).toEqual({ leaf: "refer_outside_age_range", rule: "R2" });
  });
  it("no cough and no danger signs: every danger-sign question is asked, then no_cough (R7)", () => {
    const w = walkFlow(flow, child({}));
    expect(w.asked).toEqual([
      "age_months",
      "cough",
      "convulsions",
      "not_able_to_drink_or_feed",
      "vomits_everything",
      "chest_indrawing",
      "unusually_sleepy",
    ]);
    expect(w.leaf.leaf).toBe("no_cough");
  });
  it("danger sign present (convulsions): the other general danger signs are skipped, chest indrawing and breaths decide R3 vs R4", () => {
    const w = walkFlow(flow, child({ cough: true, convulsions: true }));
    expect(w.asked).toEqual(["age_months", "cough", "cough_days", "convulsions", "chest_indrawing", "breaths_per_minute"]);
    expect(w.leaf).toEqual({ leaf: "refer_urgent", rule: "R4" });
  });
  it("literal mode (pruneIrrelevant false) asks every question until the outcome is decided", () => {
    const lit = deriveFlow(m, { pruneIrrelevant: false });
    const w = walkFlow(lit, child({ cough: true, convulsions: true }));
    expect(w.asked).toEqual([
      "age_months",
      "cough",
      "cough_days",
      "convulsions",
      "not_able_to_drink_or_feed",
      "vomits_everything",
      "chest_indrawing",
      "breaths_per_minute",
    ]);
    expect(w.leaf.leaf).toBe("refer_urgent");
    const v = verifyFlow(m, lit);
    expect(v.mismatchCount).toBe(0);
    expect(v.compiled.mismatchCount).toBe(0);
    expect(v.avgQuestions).toBeGreaterThan(verifyFlow(m, flow).avgQuestions);
  });
  it("fast-breathing child: all nine questions are asked (sleepy still decides R4 vs R5)", () => {
    const w = walkFlow(flow, child({ cough: true, breaths_per_minute: 52 }));
    expect(w.asked).toEqual(m.questions.map((x) => x.id));
    expect(w.leaf).toEqual({ leaf: "treat_fast_breathing_at_home", rule: "R5" });
  });
});

describe("Q2: a 1-month-old with convulsions (the old hazard is fixed by R1)", () => {
  const baby = child({ age_months: 1, convulsions: true });
  it("minimal flow: convulsions is asked even though the age is out of range, and R1 refers urgently", () => {
    expect(walkFlow(flow, baby).asked).toContain("convulsions");
    expect(walkFlow(flow, baby).leaf).toEqual({ leaf: "refer_urgent_outside_age_range", rule: "R1" });
  });
  it("askAllDangerSigns: every danger-sign question is asked; the outcome is unchanged", () => {
    const w = walkFlow(safe, baby);
    expect(w.asked).toEqual(["age_months", ...DANGER.filter((id) => id !== "cough_days")]);
    expect(w.leaf.leaf).toBe("refer_urgent_outside_age_range");
    const withCough = walkFlow(safe, child({ age_months: 1, cough: true }));
    expect(withCough.asked).toEqual(["age_months", ...DANGER]);
  });
  it("danger-sign questions are the questions read by the derived value danger_sign", () => {
    expect(dangerSignQuestions(m)).toEqual(DANGER);
    expect(safe.alwaysAsk).toEqual(DANGER);
    expect(flow.alwaysAsk).toEqual([]);
    const noDanger = parse({ ...rawV1(), derived: rawV1().derived.filter((d: { id: string }) => d.id !== "danger_sign"), rules: rawV1().rules.map((r: { id: string; when: unknown }) => (r.id === "R1" || r.id === "R3" || r.id === "R4" ? { ...r, when: { field: "convulsions", op: "is_yes" } } : r)) });
    expect(dangerSignQuestions(noDanger)).toEqual([]);
  });
  it("explicit alwaysAsk ids are asked whenever their own shown_when allows", () => {
    // Out-of-range child: R2 is only decided once every danger sign is answered, so the questions are asked anyway.
    // Breaths are asked only when cough is yes (their own shown_when), even though the outcome never depends on them here.
    const all9 = ["age_months", "cough", "cough_days", "convulsions", "not_able_to_drink_or_feed", "vomits_everything", "chest_indrawing", "breaths_per_minute", "unusually_sleepy"];
    const f1 = deriveFlow(m, { alwaysAsk: ["breaths_per_minute"] });
    expect(walkFlow(f1, child({ age_months: 1, cough: true })).asked).toEqual(all9);
    const f = deriveFlow(m, { alwaysAsk: ["cough", "breaths_per_minute"] });
    expect(walkFlow(f, child({ age_months: 1, cough: true })).asked).toEqual(all9);
    expect(walkFlow(f, child({ age_months: 1 })).asked).toEqual(all9.filter((id) => id !== "cough_days" && id !== "breaths_per_minute"));
    expect(verifyFlow(m, f).mismatchCount).toBe(0);
  });
});

describe("verifyFlow", () => {
  it("v1 minimal flow: 0 mismatches over all 6400 points, both walking the tree and using the compiled relevance", () => {
    const v = verifyFlow(m, flow);
    expect(v.points).toBe(6400);
    expect(v.mismatchCount).toBe(0);
    expect(v.mismatches).toEqual([]);
    expect(v.compiled.mismatchCount).toBe(0);
    expect(v.avgQuestions).toBeLessThan(v.avgQuestionsFullForm);
    expect(v.avgQuestionsSaved).toBeGreaterThan(0);
    expect(v.compiled.avgQuestions).toBeGreaterThanOrEqual(v.avgQuestions);
    expect(v.compiled.avgQuestions).toBeLessThanOrEqual(v.avgQuestionsFullForm);
    const total = Object.values(v.questionsAskedHistogram).reduce((a, b) => a + b, 0);
    expect(total).toBe(6400);
  });
  it("v1 askAllDangerSigns flow: 0 mismatches", () => {
    const v = verifyFlow(m, safe);
    expect(v.mismatchCount).toBe(0);
    expect(v.compiled.mismatchCount).toBe(0);
    expect(v.avgQuestions).toBeGreaterThan(verifyFlow(m, flow).avgQuestions);
  });
  it("mutated models: 0 mismatches (threshold moved, rule order swapped, shown_when added)", () => {
    const raws: unknown[] = [];
    const a = rawV1();
    a.derived[1].definition = { all: [{ field: "cough", op: "is_yes" }, { field: "breaths_per_minute", op: "at_least", value: 45 }] };
    raws.push(a);
    const b = rawV1();
    b.rules[1].priority = 3;
    b.rules[2].priority = 2;
    raws.push(b);
    const c = rawV1();
    c.questions[8].shown_when = { field: "age_months", op: "at_least", value: 12 };
    raws.push(c);
    const d = rawV1();
    d.rules[0].when = { field: "age_months", op: "less_than", value: 2 };
    raws.push(d);
    for (const raw of raws) {
      const mm = parse(raw);
      for (const opts of [{}, { askAllDangerSigns: true }, { pruneIrrelevant: false }]) {
        const v = verifyFlow(mm, deriveFlow(mm, opts));
        expect(v.mismatchCount).toBe(0);
        expect(v.compiled.mismatchCount).toBe(0);
        // with is_no the compiled relevance shows exactly what the tree asks
        expect(v.compiled.sequenceDifferences).toBe(0);
        expect(v.compiled.avgQuestions).toBeCloseTo(v.avgQuestions, 10);
      }
    }
  });
  it("catches a deliberately broken flow (a needed question removed from a path)", () => {
    const broken: Flow = JSON.parse(JSON.stringify(flow));
    // Replace the first ask of chest_indrawing with its "no" branch: chest indrawing is no longer asked there.
    let done = false;
    const cut = (n: FlowNode): FlowNode => {
      if (!("ask" in n)) return n;
      if (!done && n.ask === "chest_indrawing") {
        done = true;
        return n.branches.find((b) => b.region.kind === "no")!.next;
      }
      return { ask: n.ask, branches: n.branches.map((b) => ({ region: b.region, next: cut(b.next) })) };
    };
    broken.root = cut(broken.root);
    expect(done).toBe(true);
    const v = verifyFlow(m, broken);
    expect(v.mismatchCount).toBeGreaterThan(0);
    expect(v.mismatches.length).toBeLessThanOrEqual(10);
    expect(v.mismatches[0]).toHaveProperty("expected");
    expect(v.mismatches[0]).toHaveProperty("got");
  });
  it("catches a broken compiled relevance (a question's condition made too narrow)", () => {
    const broken: Flow = { ...flow, shownWhen: { ...flow.shownWhen, chest_indrawing: { field: "cough", op: "is_yes" } } };
    expect(verifyFlow(m, broken).compiled.mismatchCount).toBeGreaterThan(0);
  });
});

describe("absent answers are part of determination (exactness)", () => {
  // x is answered => R1 always holds; x left blank => otherwise. So x must be asked although every
  // answered value gives the same outcome. `a` never matters and is never asked.
  const mm = tiny({
    questions: [q("a", 1, "yes_no"), q("x", 2, "integer")],
    outcomes: ["out_a", "out_b"],
    rules: [
      { id: "R1", priority: 1, when: { field: "x", op: "at_least", value: 0 }, outcome: "out_a", origin: "team" },
      { id: "R2", priority: 2, when: "otherwise", outcome: "out_b", origin: "team" },
    ],
  });
  const f = deriveFlow(mm);
  it("asks x (blank would change the outcome) and never asks a", () => {
    expect(f.stats.questionsAlwaysAsked).toEqual(["x"]);
    expect(f.stats.neverAsked).toEqual(["a"]);
    // never asked => the flow-only constant "never" (compiled to false()), not null (= always)
    expect(f.shownWhen.a).toBe("never");
    expect(effectiveShownWhen(mm, f, "a")).toBe("never");
    expect(f.root).toEqual({ ask: "x", branches: [{ region: { kind: "range", min: null, below: null }, next: { leaf: "out_a", rule: "R1" } }] });
    const v = verifyFlow(mm, f);
    expect(v.mismatchCount).toBe(0);
    expect(v.compiled.mismatchCount).toBe(0);
  });
  it("literal mode asks a (outcome still open) with a single any-answer branch", () => {
    const lit = deriveFlow(mm, { pruneIrrelevant: false });
    expect(lit.root).toEqual({
      ask: "a",
      branches: [{ region: { kind: "any" }, next: { ask: "x", branches: [{ region: { kind: "range", min: null, below: null }, next: { leaf: "out_a", rule: "R1" } }] } }],
    });
    expect(verifyFlow(mm, lit).compiled.mismatchCount).toBe(0);
  });
  it("ignoring blank answers would be wrong: the form with x left blank gives a different outcome", () => {
    expect(evaluate(mm, { a: true, x: 5 }).outcome).toBe("out_a");
    expect(evaluate(mm, { a: true }, { allowMissing: true }).outcome).toBe("out_b");
  });
});

describe("a hand-made three-question model (not v1's shape)", () => {
  const mm = tiny({
    questions: [
      q("temp", 1, "integer"),
      q("rash", 2, "yes_no"),
      q("days", 3, "integer", { shown_when: { field: "rash", op: "is_yes" } }),
    ],
    outcomes: ["oa", "ob", "oc", "od"],
    rules: [
      { id: "R1", priority: 1, when: { all: [{ field: "temp", op: "at_least", value: 39 }, { field: "rash", op: "is_yes" }] }, outcome: "oa", origin: "team" },
      { id: "R2", priority: 2, when: { field: "temp", op: "at_least", value: 39 }, outcome: "ob", origin: "team" },
      { id: "R3", priority: 3, when: { all: [{ field: "rash", op: "is_yes" }, { field: "days", op: "at_least", value: 3 }] }, outcome: "oc", origin: "team" },
      { id: "R4", priority: 4, when: "otherwise", outcome: "od", origin: "team" },
    ],
  });
  const f = deriveFlow(mm);
  it("derives the expected tree", () => {
    expect(f.root).toEqual({
      ask: "temp",
      branches: [
        {
          region: { kind: "range", min: null, below: 39 },
          next: {
            ask: "rash",
            branches: [
              {
                region: { kind: "yes" },
                next: {
                  ask: "days",
                  branches: [
                    { region: { kind: "range", min: null, below: 3 }, next: { leaf: "od", rule: "R4" } },
                    { region: { kind: "range", min: 3, below: null }, next: { leaf: "oc", rule: "R3" } },
                  ],
                },
              },
              { region: { kind: "no" }, next: { leaf: "od", rule: "R4" } },
            ],
          },
        },
        {
          region: { kind: "range", min: 39, below: null },
          next: {
            ask: "rash",
            branches: [
              { region: { kind: "yes" }, next: { leaf: "oa", rule: "R1" } },
              { region: { kind: "no" }, next: { leaf: "ob", rule: "R2" } },
            ],
          },
        },
      ],
    });
    expect(f.stats).toMatchObject({ leaves: 5, maxDepth: 3, questionsAlwaysAsked: ["temp", "rash"], questionsSometimesSkipped: ["days"], neverAsked: [] });
  });
  it("derives shownWhen and the effective relevance", () => {
    expect(f.shownWhen).toEqual({ temp: null, rash: null, days: { all: [{ field: "temp", op: "less_than", value: 39 }, { field: "rash", op: "is_yes" }] } });
    expect(effectiveShownWhen(mm, f, "days")).toEqual({ all: [{ field: "temp", op: "less_than", value: 39 }, { field: "rash", op: "is_yes" }] });
    expect(effectiveShownWhen(mm, f, "temp")).toBeNull();
    const v = verifyFlow(mm, f);
    expect(v.mismatchCount).toBe(0);
    expect(v.compiled.mismatchCount).toBe(0);
  });
});

describe("shownWhen for v1", () => {
  // Updated for T11b (human ruling): the flow uses a FLOW-ONLY condition type, the model atoms plus
  // is_no, and the constant "never". The signed model vocabulary is unchanged.
  it("uses only the flow vocabulary (model atoms plus is_no) and is short", () => {
    const ops = new Set<string>();
    const visit = (c: unknown): void => {
      const o = c as Record<string, unknown>;
      if ("op" in o) ops.add(o.op as string);
      for (const k of ["all", "any"]) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(visit);
      for (const k of Object.keys(o)) expect(["field", "op", "value", "all", "any"]).toContain(k);
    };
    for (const c of Object.values(flow.shownWhen)) if (c && c !== "never") visit(c);
    for (const op of ops) expect(["is_yes", "is_no", "at_least", "less_than"]).toContain(op);
    expect(ops.has("is_no")).toBe(true);
    // chest_indrawing is the longest condition (about 2100 characters) under the final 7-rule model.
    for (const c of Object.values(flow.shownWhen)) expect(canonicalJson(c).length).toBeLessThan(2500);
  });
  it("age and cough are always asked (an out-of-range child still gets the danger-sign questions); cough_days needs cough yes", () => {
    expect(flow.shownWhen.age_months).toBeNull();
    expect(flow.shownWhen.cough).toBeNull();
    expect(effectiveShownWhen(m, flow, "cough_days")).toEqual({ field: "cough", op: "is_yes" });
  });
  it("'no' steps appear as is_no: after 'convulsions is no' the next danger sign is asked; after 'yes' it is not", () => {
    const sw = flow.shownWhen.not_able_to_drink_or_feed;
    expect(canonicalJson(sw)).toContain('{"field":"convulsions","op":"is_no"}');
    expect(canonicalJson(sw)).not.toContain('{"field":"convulsions","op":"is_yes"}');
    const show = (a: Answers): boolean => evalFlowCondition(effectiveShownWhen(m, flow, "not_able_to_drink_or_feed"), a);
    expect(show({ age_months: 6, cough: false, convulsions: false })).toBe(true);
    expect(show({ age_months: 6, cough: false, convulsions: true })).toBe(false);
    expect(show({ age_months: 6, cough: false })).toBe(false); // convulsions blank is not "no"
  });
});

describe("FlowCondition evaluation", () => {
  const known = { yes: true, no: false, n: 5 } as Answers;
  it("is_no is true only for an answered false; blank is false, never true", () => {
    expect(evalFlowCondition({ field: "no", op: "is_no" }, known)).toBe(true);
    expect(evalFlowCondition({ field: "yes", op: "is_no" }, known)).toBe(false);
    expect(evalFlowCondition({ field: "missing", op: "is_no" }, known)).toBe(false);
    expect(evalFlowCondition({ field: "n", op: "is_no" }, known)).toBe(false);
  });
  it("'never' is false, null is true, model atoms behave as in the interpreter", () => {
    expect(evalFlowCondition("never", known)).toBe(false);
    expect(evalFlowCondition(null, known)).toBe(true);
    const c: FlowCondition = { all: [{ field: "yes", op: "is_yes" }, { any: [{ field: "n", op: "at_least", value: 5 }, { field: "n", op: "less_than", value: 2 }] }] };
    expect(evalFlowCondition(c, known)).toBe(true);
    expect(evalFlowCondition({ field: "missing", op: "less_than", value: 9 }, known)).toBe(false);
  });
  it("has a derivation version recorded by the compiler", () => {
    expect(FLOW_DERIVATION_VERSION).toBe("flow-2-is_no");
  });
});

describe("compiled relevance equals the tree (is_no makes it exact)", () => {
  const cases: Array<[string, Flow, number, number]> = [
    // [name, flow, tree average, full form average]
    ["minimal", flow, 4.675, 8.92],
    ["askAllDangerSigns", safe, 8.2, 8.92],
    ["literal", deriveFlow(m, { pruneIrrelevant: false }), 5.735, 8.92],
  ];
  for (const [name, f, avg, full] of cases) {
    it(`${name}: 0 mismatches over 6400 points (tree and compiled); compiled average equals tree average`, () => {
      const v = verifyFlow(m, f);
      expect(v.points).toBe(6400);
      expect(v.mismatchCount).toBe(0);
      expect(v.compiled.mismatchCount).toBe(0);
      expect(v.compiled.sequenceDifferences).toBe(0);
      expect(v.avgQuestions).toBeCloseTo(avg, 2);
      expect(v.compiled.avgQuestions).toBeCloseTo(v.avgQuestions, 10);
      expect(v.compiled.questionsAskedHistogram).toEqual(v.questionsAskedHistogram);
      expect(v.avgQuestionsFullForm).toBeCloseTo(full, 2);
    });
  }
});

describe("plain outputs", () => {
  it("flowToMermaid uses labels, plain edge words and outcome titles", () => {
    const s = flowToMermaid(flow, m);
    expect(s.startsWith("flowchart TD")).toBe(true);
    expect(s).toContain("Child's age in months");
    expect(s).toContain("2 to 11 months");
    expect(s).toContain("under 2 months");
    expect(s).toContain("60 months or more");
    expect(s).toContain('"yes"');
    expect(s).toContain('"no"');
    expect(s).toContain("Outside this form's age range, no danger sign: refer to health facility");
    expect(s).toContain("Danger sign, outside this form's age range: refer urgently. Give no medicine from this form.");
    expect(flowToMermaid(flow, m)).toBe(s);
  });
  it("describeFlow gives plain sentences without operators or jargon", () => {
    const lines = describeFlow(flow, m);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines).toContain(
      'If "Child\'s age in months" is under 2 months or 60 months or more, and "Does the child have a cough?" is yes, and "For how many days has the child had the cough?" is 14 days or more, the form ends: Danger sign, outside this form\'s age range: refer urgently. Give no medicine from this form.',
    );
    for (const l of lines) {
      expect(l).not.toMatch(/[<>=]|is_yes|at_least|less_than|AST|null|undefined/);
    }
    expect(describeFlow(flow, m)).toEqual(lines);
  });
});

describe("describeFlowByOutcome (grouped for reviewers)", () => {
  it("groups the path sentences by outcome, in model outcome order, same paths as describeFlow", () => {
    const groups = describeFlowByOutcome(flow, m);
    expect(groups.map((g) => g.outcome)).toEqual(m.outcomes.map((o) => o.id).filter((id) => groups.some((g) => g.outcome === id)));
    const r2 = groups.find((g) => g.outcome === "refer_outside_age_range")!;
    expect(r2.title).toBe("Outside this form's age range, no danger sign: refer to health facility");
    // two paths (cough yes with under 14 days, and no cough), each after all five danger-sign questions are answered no
    expect(r2.when).toHaveLength(2);
    for (const w of r2.when) {
      expect(w.startsWith('"Child\'s age in months" is under 2 months or 60 months or more, and "Does the child have a cough?" is ')).toBe(true);
      expect(w.endsWith('"Look: is the child unusually sleepy or unconscious?" is no')).toBe(true);
    }
    const r1 = groups.find((g) => g.outcome === "refer_urgent_outside_age_range")!;
    expect(r1.title).toBe("Danger sign, outside this form's age range: refer urgently. Give no medicine from this form.");
    const total = groups.reduce((a, g) => a + g.when.length, 0);
    expect(total).toBe(describeFlow(flow, m).filter((l) => l.includes("the form ends:")).length);
    for (const g of groups) for (const w of g.when) expect(w).not.toMatch(/[<>=]|is_yes|is_no|at_least|less_than/);
  });
});

describe("determinism and guards", () => {
  it("same JSON twice gives the same flow", () => {
    const a = deriveFlow(parse(rawV1()));
    const b = deriveFlow(parse(rawV1()));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(canonicalJson(flow));
  });
  it("maxNodes guard throws a clear error instead of hanging", () => {
    expect(() => deriveFlow(m, { maxNodes: 5 })).toThrow(FlowTooLargeError);
    expect(() => deriveFlow(m, { maxNodes: 5 })).toThrow(/more than 5 nodes/);
  });
  it("leaves agree with the interpreter on full answers for golden-like children", () => {
    for (const a of [child({}), child({ cough: true, breaths_per_minute: 52 }), child({ age_months: 70 })]) {
      expect(walkFlow(flow, a).leaf.leaf).toBe(evaluate(m, a).outcome);
    }
  });
});
