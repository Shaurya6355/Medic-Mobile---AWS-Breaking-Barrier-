import { describe, expect, it } from "vitest";
import { checkCompileReady } from "../../src/compiler/readiness.js";
import { demoSettings, parse, rawV1, v1 } from "./helpers.js";

describe("checkCompileReady", () => {
  it("the fixture with demo settings is ready, with a TEAM_DEFAULT_USED warning naming Q5", () => {
    const r = checkCompileReady(v1(), demoSettings());
    expect(r.compile_ready).toBe(true);
    expect(r.missing).toEqual([]);
    const team = r.warnings.filter((w) => w.startsWith("TEAM_DEFAULT_USED"));
    expect(team).toHaveLength(1);
    expect(team[0]).toContain("treat_fast_breathing_at_home");
    expect(team[0]).toContain("Q5");
    expect(team[0]).toContain("7");
    expect(r.taskWindows).toEqual({ treat_fast_breathing_at_home: 7 });
  });

  it("lists on_return follow-ups as not compiled, with the fixed reason", () => {
    const r = checkCompileReady(v1(), demoSettings());
    expect(r.notCompiled).toEqual([
      { item: "outcomes.refer_outside_age_range.follow_up", reason: "needs a return date (no trigger defined)" },
      { item: "outcomes.refer_urgent_with_antibiotic.follow_up", reason: "needs a return date (no trigger defined)" },
      { item: "outcomes.refer_urgent.follow_up", reason: "needs a return date (no trigger defined)" },
    ]);
  });

  it("refuses a null task window without a team default and lists every missing field", () => {
    const r = checkCompileReady(v1(), demoSettings({ taskWindowDays: undefined, formTitle: "", icon: " " }));
    expect(r.compile_ready).toBe(false);
    expect(r.missing).toEqual([
      "settings.formTitle",
      "settings.icon",
      "outcomes.treat_fast_breathing_at_home.follow_up.task_window_days_after_due (null and no settings.taskWindowDays; see Q5)",
    ]);
  });

  it("refuses a scheduled follow-up without due_in_days", () => {
    const raw = rawV1();
    raw.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").follow_up.due_in_days = null;
    const r = checkCompileReady(parse(raw), demoSettings());
    expect(r.compile_ready).toBe(false);
    expect(r.missing).toEqual(["outcomes.treat_fast_breathing_at_home.follow_up.due_in_days"]);
  });

  it("uses the model's own window when present, with no warning", () => {
    const raw = rawV1();
    raw.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").follow_up.task_window_days_after_due = 4;
    const r = checkCompileReady(parse(raw), demoSettings());
    expect(r.taskWindows).toEqual({ treat_fast_breathing_at_home: 4 });
    expect(r.warnings.filter((w) => w.startsWith("TEAM_DEFAULT_USED"))).toEqual([]);
  });

  it("refuses dose_by_age when there is no integer age_months question", () => {
    const raw = rawV1();
    raw.questions = raw.questions.filter((q: any) => q.id !== "age_months");
    raw.rules[0].when = { field: "cough", op: "is_yes" };
    for (const d of raw.derived) d.definition = { field: "cough", op: "is_yes" };
    const r = checkCompileReady(parse(raw), demoSettings());
    expect(r.compile_ready).toBe(false);
    expect(r.missing).toContain("questions.age_months (integer; needed by dose_by_age)");
  });

  it("refuses a numeric comparison on a derived value or a yes_no question", () => {
    const raw = rawV1();
    raw.rules[3].when = { field: "fast_breathing", op: "at_least", value: 1 };
    raw.rules[4].when = { field: "cough", op: "less_than", value: 1 };
    const r = checkCompileReady(parse(raw), demoSettings());
    expect(r.compile_ready).toBe(false);
    expect(r.missing).toEqual([
      'rules.R4.when: "fast_breathing" is not an integer question (at_least)',
      'rules.R5.when: "cough" is not an integer question (less_than)',
    ]);
  });

  it("refuses a condition that reads an undeclared field", () => {
    const raw = rawV1();
    raw.questions[2].shown_when = { field: "nope", op: "is_yes" };
    const r = checkCompileReady(parse(raw), demoSettings());
    expect(r.missing).toEqual(['questions.cough_days.shown_when: "nope" is not a declared question or derived value']);
  });
});
