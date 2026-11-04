import { describe, expect, it } from "vitest";
import { buildForm, SURVEY_COLUMNS } from "../../src/compiler/form.js";
import { demoSettings, v1 } from "./helpers.js";

const form = () => buildForm(v1(), demoSettings(), "preview-abcdef12");
// T11b: the default flowMode is "minimal", which adds the derived flow to each question's relevant.
// Tests of the authored emission alone use flowMode "full"; flow relevance is tested in flow.test.ts.
const fullForm = () => buildForm(v1(), demoSettings({ flowMode: "full" }), "preview-abcdef12");
const row = (name: string) => {
  const r = fullForm().survey.find((x) => x.name === name);
  if (!r) throw new Error(`no row ${name}`);
  return r;
};

describe("buildForm: structure", () => {
  it("has the CHT inputs group with source, source_id and the contact _id / patient id", () => {
    const s = form().survey;
    expect(s.slice(0, 9).map((r) => [r.type, r.name])).toEqual([
      ["begin group", "inputs"],
      ["hidden", "source"],
      ["hidden", "source_id"],
      ["begin group", "contact"],
      ["string", "_id"],
      ["hidden", "name"],
      ["hidden", "patient_id"],
      ["end group", "contact"],
      ["end group", "inputs"],
    ]);
    expect(s[0]).toMatchObject({ relevant: "./source = 'user'", appearance: "field-list" });
    // cht-conf 6.6 deprecates NO_LABEL; groups need no label
    expect(s[0]?.label).toBeUndefined();
    expect(s.some((r) => r.label === "NO_LABEL")).toBe(false);
    expect(s[1]).toMatchObject({ default: "user" });
    expect(s[4]).toMatchObject({ appearance: "select-contact type-person" });
  });

  it("uses type-clinic for the contact selector when only places apply", () => {
    const f = buildForm(v1(), demoSettings({ contactTypes: { person: false, place: true } }), "v");
    expect(f.survey[4]?.appearance).toBe("select-contact type-clinic");
  });

  it("copies the patient ids to top-level calculates so the report links to the patient", () => {
    expect(row("patient_uuid")).toMatchObject({ type: "calculate", calculation: "../inputs/contact/_id" });
    expect(row("patient_id")).toBeDefined();
    const top = form().survey.filter((r) => r.name === "patient_id" && r.type === "calculate");
    expect(top).toHaveLength(1);
    expect(top[0]?.calculation).toBe("../inputs/contact/patient_id");
    expect(row("patient_name")).toMatchObject({ type: "calculate", calculation: "../inputs/contact/name" });
  });

  it("puts each question in its own top-level group (one screen each), model order, results last", () => {
    const s = form().survey;
    const m = v1();
    const names = s.map((r) => `${r.type}:${r.name}`);
    expect(names.includes("begin group:assessment")).toBe(false);
    const qStart = names.indexOf(`begin group:q_${m.questions[0]?.id}`);
    expect(qStart).toBeGreaterThan(0);
    const expected: string[] = [];
    for (const q of m.questions) expected.push(`begin group:q_${q.id}`, `${q.answer_type === "yes_no" ? "select_one yes_no" : "integer"}:${q.id}`, `end group:q_${q.id}`);
    expect(names.slice(qStart, qStart + expected.length)).toEqual(expected);
    expect(names[names.length - 1]).toBe("end group:results");
    expect(names.indexOf("begin group:results")).toBeGreaterThan(names.indexOf("calculate:outcome"));
  });

  it("question groups are field-list, unlabelled, and carry the question's relevant", () => {
    const s = form().survey;
    for (const q of v1().questions) {
      const g = s.find((r) => r.type === "begin group" && r.name === `q_${q.id}`);
      const qr = s.find((r) => r.name === q.id);
      expect(g).toBeDefined();
      expect(g?.appearance).toBe("field-list");
      expect(g?.label).toBeUndefined();
      expect(g?.relevant).toBe(qr?.relevant);
      expect(g?.required).toBeUndefined();
    }
    // the question rows keep their own relevant too (flowMode full: authored shown_when only)
    const full = fullForm().survey;
    expect(row("cough_days").relevant).toBe("${cough} = 'yes'");
    expect(full.find((r) => r.name === "q_cough_days")?.relevant).toBe("${cough} = 'yes'");
    expect(s.find((r) => r.name === "q_age_months")?.relevant).toBeUndefined();
  });

  it("calculates are never inside a paged (top-level) group other than inputs", () => {
    const depth: string[] = [];
    for (const r of form().survey) {
      if (r.type === "begin group") depth.push(r.name);
      else if (r.type === "end group") depth.pop();
      else if (r.type === "calculate") expect(depth).toEqual([]);
    }
  });

  it("every top-level group is inputs, one question group, or results (page list)", () => {
    const top: string[] = [];
    let d = 0;
    for (const r of form().survey) {
      if (r.type === "begin group") {
        if (d === 0) top.push(r.name);
        d++;
      } else if (r.type === "end group") d--;
    }
    expect(top).toEqual(["inputs", ...v1().questions.map((q) => `q_${q.id}`), "results"]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(form())).toBe(JSON.stringify(form()));
  });

  it("only uses known columns", () => {
    for (const r of form().survey) for (const k of Object.keys(r)) expect(SURVEY_COLUMNS).toContain(k);
  });
});

describe("buildForm: questions", () => {
  it("integer question: constraint, message, required", () => {
    expect(row("age_months")).toEqual({
      type: "integer",
      name: "age_months",
      label: "Child's age in months",
      required: "yes",
      constraint: ". >= 0 and . <= 120",
      constraint_message: "Enter age in whole months.",
    });
  });
  it("integer question with shown_when gets relevant", () => {
    expect(row("cough_days")).toEqual({
      type: "integer",
      name: "cough_days",
      label: "For how many days has the child had the cough?",
      required: "yes",
      relevant: "${cough} = 'yes'",
      constraint: ". >= 0 and . <= 365",
      constraint_message: "Enter a number of days.",
    });
  });
  it("yes_no question is select_one yes_no", () => {
    expect(row("convulsions")).toEqual({
      type: "select_one yes_no",
      name: "convulsions",
      label: "Has the child had convulsions?",
      required: "yes",
    });
  });
  it("choices sheet has yes/no", () => {
    expect(form().choices).toEqual([
      { list_name: "yes_no", name: "yes", label: "Yes" },
      { list_name: "yes_no", name: "no", label: "No" },
    ]);
  });
});

describe("buildForm: logic", () => {
  it("derived values are yes/no calculates", () => {
    expect(row("danger_sign")).toEqual({
      type: "calculate",
      name: "danger_sign",
      calculation:
        "if(((${cough} = 'yes' and (${cough_days} != '' and ${cough_days} >= 14)) or ${convulsions} = 'yes' or " +
        "${not_able_to_drink_or_feed} = 'yes' or ${vomits_everything} = 'yes' or ${chest_indrawing} = 'yes' or " +
        "${unusually_sleepy} = 'yes'), 'yes', 'no')",
    });
  });
  it("one outcome calculate with nested if() in priority order", () => {
    expect(row("outcome")).toEqual({
      type: "calculate",
      name: "outcome",
      calculation:
        "if((${outside_age_range} = 'yes' and ${danger_sign} = 'yes'), 'refer_urgent_outside_age_range', " +
        "if(${outside_age_range} = 'yes', 'refer_outside_age_range', " +
        "if((${danger_sign} = 'yes' and (${fast_breathing} = 'yes' or ${chest_indrawing} = 'yes')), 'refer_urgent_with_antibiotic', " +
        "if(${danger_sign} = 'yes', 'refer_urgent', " +
        "if(${fast_breathing} = 'yes', 'treat_fast_breathing_at_home', " +
        "if(${cough} = 'yes', 'cough_no_fast_breathing', 'no_cough'))))))",
    });
  });
});

describe("buildForm: outcome display", () => {
  it("one never-required note per outcome, label = title plus action texts", () => {
    const notes = form().survey.filter((r) => r.type === "note");
    for (const o of v1().outcomes) {
      const n = notes.find((r) => r.name === `outcome_${o.id}`);
      expect(n).toBeDefined();
      expect(n?.relevant).toBe(`\${outcome} = '${o.id}'`);
      expect(n?.label).toBe([o.title, ...o.actions.map((a) => a.text)].join("\n"));
    }
    for (const n of notes) expect(n.required).toBeUndefined();
  });
  it("dose_by_age gives one note per age band", () => {
    const n = row("outcome_treat_fast_breathing_at_home_dose_1_2");
    expect(n).toEqual({
      type: "note",
      name: "outcome_treat_fast_breathing_at_home_dose_1_2",
      label: "Age 12 to under 60 months: 2 tablets (total 20 tablets)",
      relevant:
        "${outcome} = 'treat_fast_breathing_at_home' and (${age_months} != '' and ${age_months} >= 12) and " +
        "(${age_months} != '' and ${age_months} < 60)",
    });
    expect(row("outcome_refer_urgent_with_antibiotic_dose_1_1").label).toBe("Age 2 to under 12 months: 1 tablet");
  });
  it("the results group contains every note", () => {
    const s = form().survey;
    const begin = s.findIndex((r) => r.name === "results" && r.type === "begin group");
    const notes = s.filter((r) => r.type === "note");
    expect(s.slice(begin + 1, -1)).toEqual(notes);
    expect(notes).toHaveLength(7 + 4);
  });
});

describe("buildForm: settings, properties, sourcemap", () => {
  it("settings sheet", () => {
    expect(form().settings).toEqual({
      form_title: "Cough and fast breathing (demo)",
      form_id: "cough_fast_breathing",
      version: "preview-abcdef12",
      default_language: "en",
      // Regression (found by the enketo preview, t8): without style=pages, pyxform emits no
      // <h:body class="pages">, so enketo-core (features.pagination) and the CHT webapp show every
      // group on one long scrolling page instead of one page per field-list group. All CHT default
      // app forms (cht-core config/default/forms/app/*.xml) carry class="pages".
      style: "pages",
    });
  });
  it("properties.json", () => {
    expect(form().properties).toEqual({
      title: [{ locale: "en", content: "Cough and fast breathing (demo)" }],
      icon: "icon-healthcare",
      context: { person: true, place: false },
    });
  });
  it("sourcemap covers every question, derived, outcome and rule with row numbers", () => {
    const f = form();
    const m = v1();
    const items = (kind: string) => f.sourcemap.filter((e) => e.kind === kind).map((e) => e.item);
    expect(items("question")).toEqual(m.questions.map((q) => q.id));
    expect(items("derived")).toEqual(m.derived.map((d) => d.id));
    expect(items("outcome_note")).toEqual(m.outcomes.map((o) => o.id));
    expect(items("rule")).toEqual(m.rules.map((r) => r.id));
    for (const e of f.sourcemap) {
      const r = f.survey[(e.target.row as number) - 2];
      expect(r?.name).toBe(e.target.name);
    }
    const age = f.sourcemap.find((e) => e.item === "age_months");
    expect(age?.sources).toEqual([{ page: 3, quote: "child age 2 months up to 5 years" }]);
    const r6 = f.sourcemap.find((e) => e.item === "R6");
    expect(r6).toMatchObject({ origin: "team", sources: [], target: { name: "outcome" } });
  });
});
