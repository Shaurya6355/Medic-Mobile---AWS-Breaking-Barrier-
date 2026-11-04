import { describe, expect, it } from "vitest";
import { buildTasks, jsString, translationsFile } from "../../src/compiler/tasks.js";
import { demoSettings, v1 } from "./helpers.js";

const SHA = "f".repeat(64);
const built = () => buildTasks(v1(), demoSettings(), { treat_fast_breathing_at_home: 7 }, SHA);

function load(js: string): any[] {
  const module = { exports: undefined as unknown };
  new Function("module", "exports", js)(module, {});
  return module.exports as any[];
}

const DAY = 24 * 60 * 60 * 1000;

describe("jsString", () => {
  it("single-quotes and escapes", () => {
    expect(jsString("a")).toBe("'a'");
    expect(jsString("it's \\ \n")).toBe("'it\\'s \\\\ \\n'");
  });
});

describe("buildTasks", () => {
  it("one task per scheduled follow-up only (on_return and null are skipped)", () => {
    const tasks = load(built().js);
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t).toMatchObject({
      name: "cough_fast_breathing.treat_fast_breathing_at_home.follow_up",
      icon: "icon-healthcare",
      title: "task.cough_fast_breathing.treat_fast_breathing_at_home.title",
      appliesTo: "reports",
      appliesToType: ["cough_fast_breathing"],
      actions: [{ type: "report", form: "cough_fast_breathing" }],
      events: [{ id: "treat_fast_breathing_at_home-follow-up", days: 3, start: 0, end: 7 }],
    });
    expect(typeof t.appliesIf).toBe("function");
    expect(typeof t.resolvedIf).toBe("function");
  });

  it("appliesIf reads the saved outcome field", () => {
    const t = load(built().js)[0];
    expect(t.appliesIf({}, { fields: { outcome: "treat_fast_breathing_at_home" } })).toBe(true);
    expect(t.appliesIf({}, { fields: { outcome: "refer_urgent" } })).toBe(false);
    expect(t.appliesIf({}, { fields: {} })).toBe(false);
  });

  it("resolvedIf: a later report of the same form for the same patient inside the window", () => {
    const t = load(built().js)[0];
    const reported = new Date(2026, 0, 10, 9, 0, 0).getTime();
    const due = new Date(2026, 0, 13).getTime();
    const event = { start: 0, end: 7 };
    const source = { _id: "r1", form: "cough_fast_breathing", reported_date: reported };
    const followUp = { _id: "r2", form: "cough_fast_breathing", reported_date: due + 2 * DAY };
    const other = { _id: "r3", form: "something_else", reported_date: due + 2 * DAY };
    const late = { _id: "r4", form: "cough_fast_breathing", reported_date: due + 9 * DAY };
    expect(t.resolvedIf({ reports: [source] }, source, event, due)).toBe(false);
    expect(t.resolvedIf({ reports: [source, other] }, source, event, due)).toBe(false);
    expect(t.resolvedIf({ reports: [source, late] }, source, event, due)).toBe(false);
    expect(t.resolvedIf({ reports: [source, followUp] }, source, event, due)).toBe(true);
  });

  it("is lint-friendly source: single quotes, semicolons, no double-quoted strings", () => {
    const js = built().js;
    expect(js).not.toMatch(/"/);
    expect(js).toContain("module.exports = [");
    expect(js).toContain(SHA.slice(0, 8));
  });

  it("returns every translation key it uses", () => {
    expect(built().translations).toEqual({
      "task.cough_fast_breathing.treat_fast_breathing_at_home.title":
        "Follow up: Fast breathing (pneumonia): treat at home and follow up in 3 days",
    });
  });

  it("sourcemap entries for each task", () => {
    expect(built().sourcemap).toEqual([
      {
        target: { file: "tasks.js", name: "cough_fast_breathing.treat_fast_breathing_at_home.follow_up" },
        kind: "task",
        item: "treat_fast_breathing_at_home",
        origin: "guideline",
        sources: [{ page: 9, quote: "Follow up child in 3 days." }],
      },
    ]);
  });

  it("an empty task list is still a valid module", () => {
    const b = buildTasks(v1(), demoSettings(), {}, SHA);
    expect(load(b.js)).toEqual([]);
  });
});

describe("translationsFile", () => {
  it("sorted key = value lines, newline escaped", () => {
    expect(translationsFile({ "b.k": "two\nlines", "a.k": "one" })).toBe("a.k = one\nb.k = two\\nlines\n");
  });
});
