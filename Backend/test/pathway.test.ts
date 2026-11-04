/* The shared pathway compiler: parse/print, semantic checks, evaluation, XLSForm, test generation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../../shared/pathway/index.ts";

const SPEC = JSON.parse(readFileSync(new URL("../../shared/pathway/samples/cough_fast_breathing.v1.json", import.meta.url), "utf8")) as P.Spec;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const base: P.Answers = { age_months: 24, cough: true, cough_days: 3, convulsions: false, not_able_to_drink_or_feed: false, vomits_everything: false, chest_indrawing: false, breaths_per_minute: 30, unusually_sleepy: false };
const errors = (s: unknown) => P.validateSpec(s).diagnostics.filter(d => d.level === "error").map(d => (d.path ? d.path + ": " : "") + d.message).join(" | ");

test("sample spec compiles with no diagnostics", () => {
  const r = P.validateSpec(SPEC);
  assert.ok(r.spec);
  assert.deepEqual(r.diagnostics, []);
});

test("conditions print and parse back to the same tree", () => {
  for (const c of [...SPEC.rules.map(r => r.when).filter(w => w !== "otherwise"), ...SPEC.derived.map(d => d.definition)] as P.Cond[]) {
    assert.deepEqual(P.parse(P.print(c)), c);
  }
  assert.deepEqual(P.parse("not (a is yes or b >= 3)"), { not: { any: [{ field: "a", op: "is_yes" }, { field: "b", op: "at_least", value: 3 }] } });
  assert.throws(() => P.parse("cough is maybe"), /Expected yes or no/);
  assert.throws(() => P.parse("age_months >="), /Expected a number/);
});

test("first match by priority, hidden questions read as unanswered", () => {
  const out = (a: P.Answers) => P.evaluate(SPEC, { ...base, ...a }).outcome;
  assert.equal(out({ age_months: 8, breaths_per_minute: 50 }), "treat_fast_breathing_at_home");
  assert.equal(out({ age_months: 12, breaths_per_minute: 40 }), "treat_fast_breathing_at_home");
  assert.equal(out({ age_months: 11, breaths_per_minute: 49 }), "cough_no_fast_breathing");
  assert.equal(out({ chest_indrawing: true }), "refer_urgent_with_antibiotic");
  assert.equal(out({ convulsions: true }), "refer_urgent");
  assert.equal(out({ age_months: 60 }), "refer_outside_age_range");
  // cough = no hides cough_days and breaths, so 20 days of cough and 70/min must not count.
  assert.equal(out({ cough: false, cough_days: 20, breaths_per_minute: 70 }), "no_cough");
});

test("semantic errors are caught", () => {
  const s1 = clone(SPEC); s1.rules[1].when = { field: "chest_indrawin", op: "is_yes" };
  assert.match(errors(s1), /Unknown field chest_indrawin/);
  const s2 = clone(SPEC); s2.rules[3].when = { field: "breaths_per_minute", op: "is_yes" };
  assert.match(errors(s2), /is a number/);
  const s3 = clone(SPEC); s3.rules[5].priority = 0;
  assert.match(errors(s3), /must have the last priority/);
  const s4 = clone(SPEC); s4.rules[2].outcome = "nope";
  assert.match(errors(s4), /Unknown outcome nope/);
  const s5 = clone(SPEC); s5.derived[0].definition = { field: "danger_sign", op: "is_yes" }; s5.derived[1].definition = { field: "fast_breathing", op: "is_yes" };
  assert.match(errors(s5), /cycle/);
  const s6 = clone(SPEC); s6.questions[1].shown_when = { field: "cough_days", op: "at_least", value: 1 };
  assert.match(errors(s6), /asked later/);
  assert.match(errors({ ...clone(SPEC), rules: "x" }), /rules: must be a list/);
});

test("XLSForm classification is the rule chain in priority order", () => {
  const rows = P.toXlsForm(SPEC);
  const cls = rows.find(r => r[1] === "classification")![4];
  assert.ok(cls.startsWith("if(${age_months} < 2 or ${age_months} >= 60, 'refer_outside_age_range', "));
  assert.ok(cls.endsWith("'cough_no_fast_breathing', 'no_cough')))))"));
  assert.equal(rows.find(r => r[1] === "breaths_per_minute")![3], "${cough} = 'yes'");
});

test("boundary patients reach every rule; mutants are caught", () => {
  const ps = P.patients(SPEC);
  const fired = new Set(ps.map(p => P.evaluate(SPEC, p).rule));
  assert.deepEqual([...fired].sort(), SPEC.rules.map(r => r.id).sort());
  const m = P.mutationScore(SPEC, ps);
  assert.ok(m.killed >= m.total - 2, JSON.stringify(m));
});
