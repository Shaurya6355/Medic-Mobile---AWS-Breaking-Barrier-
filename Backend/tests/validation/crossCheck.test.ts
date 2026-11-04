import { describe, expect, it } from "vitest";
import { MESSAGE_CODES, crossCheck, loadCrossCheck, render, runChecks } from "../../src/validation/index.js";
import type { CheckContext, Finding } from "../../src/validation/index.js";
import { JARGON_RE, matchedCtx, v1Copy } from "./helpers.js";

/** The first draft is v1.json; the second draft is a copy that a test changes. */
function ctxWith(mutateSecond?: (m: any) => void, extra: Partial<CheckContext> = {}): CheckContext {
  return { model: v1Copy(), crossCheck: { model: v1Copy(mutateSecond) }, ...extra };
}
const find = (fs: readonly Finding[], code: string): Finding | undefined => fs.find((f) => f.code === code);
const all = (fs: readonly Finding[], code: string): Finding[] => fs.filter((f) => f.code === code);
const warnings = (fs: readonly Finding[]): Finding[] => fs.filter((f) => f.severity === "warning");

/** Gives every question, calculated value and result a new id and rewrites every reference to it. */
function renameEveryId(m: any): void {
  const qs = new Set<string>(m.questions.map((x: any) => x.id));
  const ds = new Set<string>(m.derived.map((x: any) => x.id));
  const f = (id: string): string => (qs.has(id) ? `q_${id}` : ds.has(id) ? `d_${id}` : id);
  const cond = (c: any): void => {
    if ("field" in c) c.field = f(c.field);
    else for (const k of c.all ?? c.any) cond(k);
  };
  for (const q of m.questions) if (q.shown_when) cond(q.shown_when);
  for (const d of m.derived) cond(d.definition);
  for (const r of m.rules) {
    if (r.when !== "otherwise") cond(r.when);
    r.outcome = `o_${r.outcome}`;
  }
  for (const q of m.questions) q.id = `q_${q.id}`;
  for (const d of m.derived) d.id = `d_${d.id}`;
  for (const o of m.outcomes) o.id = `o_${o.id}`;
}

/** Removes a yes-or-no question and every condition that reads it. */
function dropQuestion(m: any, id: string): void {
  const strip = (c: any): any => {
    if ("field" in c) return c;
    const kids = (c.all ?? c.any).filter((k: any) => !("field" in k && k.field === id)).map(strip);
    return "all" in c ? { all: kids } : { any: kids };
  };
  for (const d of m.derived) d.definition = strip(d.definition);
  m.questions = m.questions.filter((q: any) => q.id !== id);
}

/** Replaces every cut-off number `from` with `to` in the calculated values of a draft. */
function changeCutoff(m: any, from: number, to: number): void {
  const walk = (c: any): void => {
    if ("field" in c) {
      if (c.value === from) c.value = to;
    } else for (const k of c.all ?? c.any) walk(k);
  };
  for (const d of m.derived) walk(d.definition);
}

describe("crossCheck: when it runs", () => {
  it("is silent without a second draft", () => {
    expect(crossCheck({ model: v1Copy() })).toEqual([]);
  });

  it("says plainly when the second draft cannot be read as a logic model", () => {
    const out = crossCheck({ model: v1Copy(), crossCheck: loadCrossCheck({ not: "a model" }) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "CROSS_CHECK_SECOND_DRAFT_INVALID", severity: "warning", decidedBy: "clinician" });
  });

  it("reads a valid second draft", () => {
    expect("model" in loadCrossCheck(JSON.parse(JSON.stringify(v1Copy())))).toBe(true);
  });

  it("two identical drafts differ nowhere, and the summary says how many combinations were compared", () => {
    const out = crossCheck(ctxWith());
    expect(warnings(out)).toEqual([]);
    const s = find(out, "CROSS_CHECK_SUMMARY");
    expect(s?.severity).toBe("info");
    expect(s?.params["differing"]).toBe(0);
    expect(Number(s?.params["compared"])).toBeGreaterThan(1000);
  });

  it("matches by the words of the label when every id is different", () => {
    const out = crossCheck(ctxWith(renameEveryId));
    expect(warnings(out)).toEqual([]);
    expect(find(out, "CROSS_CHECK_SUMMARY")?.params["differing"]).toBe(0);
  });

  it("gives the same findings, with the same ids, every time", () => {
    const run = () => crossCheck(ctxWith((m) => changeCutoff(m, 50, 40))).map((f) => f.id);
    expect(run()).toEqual(run());
    expect(run().length).toBeGreaterThan(1);
  });
});

describe("crossCheck: structure", () => {
  it("reports a different cut-off number, and the children who get a different result because of it", () => {
    const out = crossCheck(ctxWith((m) => changeCutoff(m, 50, 40)));
    const cut = find(out, "CROSS_CHECK_CUTOFF_DIFFERS");
    expect(cut?.params["question"]).toContain("breaths");
    expect(cut?.params["first"]).toBe("40 or more, 50 or more");
    expect(cut?.params["second"]).toBe("40 or more");
    const d = all(out, "CROSS_CHECK_DISAGREEMENT");
    expect(d.length).toBeGreaterThan(0);
    // A baby of 2 to 11 months with 40 to 49 breaths is not fast breathing in the first draft but is in the second.
    const hit = d.find((f) => f.params["firstOutcome"] !== f.params["secondOutcome"] && f.params["direction"] === "more_urgent_in_second");
    expect(hit).toBeDefined();
    expect(hit?.params["child"]).toContain("aged");
    expect(Number(hit?.params["count"])).toBeGreaterThan(0);
    expect(hit?.example).toBeDefined();
  });

  it("pairs questions the drafts word a little differently, by their clinical words and by the one whole-number question in a unit", () => {
    const out = crossCheck(
      ctxWith((m) => {
        m.questions.find((q: any) => q.id === "cough_days").label = "For how many days has the child had a cough?";
        m.questions.find((q: any) => q.id === "chest_indrawing").label = "Is there chest indrawing?";
        m.questions.find((q: any) => q.id === "age_months").label = "How old is the child, in months?";
        m.questions.find((q: any) => q.id === "breaths_per_minute").label = "If the child has a cough, how many breaths are counted in 1 minute?";
      }),
    );
    expect(find(out, "CROSS_CHECK_QUESTION_ONLY_IN_ONE")).toBeUndefined();
    expect(warnings(out)).toEqual([]);
    expect(find(out, "CROSS_CHECK_SUMMARY")?.params["differing"]).toBe(0);
  });

  it("never pairs different symptoms just because they are the same kind of question", () => {
    const out = crossCheck(
      ctxWith((m) => {
        dropQuestion(m, "vomits_everything");
        m.questions.push({ id: "has_rash", order: 100, label: "Does the child have a rash?", answer_type: "yes_no", required: true, origin: "team" });
      }),
    );
    const only = all(out, "CROSS_CHECK_QUESTION_ONLY_IN_ONE");
    expect(only.map((f) => f.params["draft"]).sort()).toEqual(["first", "second"]);
    expect(only.some((f) => String(f.params["question"]).includes("rash") && f.params["draft"] === "second")).toBe(true);
  });

  it("compares a large shared set of combinations (hundreds of thousands) within the default limit", () => {
    const out = crossCheck(
      ctxWith((m) => {
        for (let i = 0; i < 5; i++) m.questions.push({ id: `extra_${i}`, order: 200 + i, label: `Unused extra question ${i}?`, answer_type: "yes_no", required: true, origin: "team" });
      }),
    );
    expect(find(out, "CROSS_CHECK_NOT_COMPARED")).toBeUndefined();
    const s = find(out, "CROSS_CHECK_SUMMARY");
    expect(Number(s?.params["compared"])).toBeGreaterThan(300000);
    expect(s?.params["differing"]).toBe(0);
  });

  it("reports a question only one draft asks, and what that does to the result", () => {
    const out = crossCheck(
      ctxWith((m) => {
        const stripSleepy = (c: any): any => {
          if ("field" in c) return c;
          const kids = (c.all ?? c.any).filter((k: any) => !("field" in k && k.field === "unusually_sleepy")).map(stripSleepy);
          return "all" in c ? { all: kids } : { any: kids };
        };
        for (const d of m.derived) d.definition = stripSleepy(d.definition);
        m.questions = m.questions.filter((q: any) => q.id !== "unusually_sleepy");
      }),
    );
    const q = find(out, "CROSS_CHECK_QUESTION_ONLY_IN_ONE");
    expect(q?.params["draft"]).toBe("first");
    expect(String(q?.params["question"]).toLowerCase()).toContain("sleepy");
    const d = all(out, "CROSS_CHECK_DISAGREEMENT");
    expect(d.some((f) => String(f.params["child"]).toLowerCase().includes("sleepy"))).toBe(true);
  });

  it("reports a question only the second draft asks, by naming it in the example", () => {
    const out = crossCheck(
      ctxWith((m) => {
        m.questions.push({ id: "has_rash", order: 100, label: "Does the child have a rash?", answer_type: "yes_no", required: true, origin: "team" });
        const r1 = m.rules.find((r: any) => r.id === "R7");
        r1.when = "otherwise";
        m.rules.find((r: any) => r.id === "R6").when = { all: [{ field: "cough", op: "is_yes" }, { field: "has_rash", op: "is_yes" }] };
      }),
    );
    expect(find(out, "CROSS_CHECK_QUESTION_ONLY_IN_ONE")?.params["draft"]).toBe("second");
    const d = all(out, "CROSS_CHECK_DISAGREEMENT");
    expect(d.some((f) => String(f.params["extra"]).includes("rash"))).toBe(true);
  });

  it("reports a different kind of answer or different entry limits for the same question", () => {
    const out = crossCheck(ctxWith((m) => { m.questions.find((q: any) => q.id === "age_months").constraint.max = 59; }));
    const f = find(out, "CROSS_CHECK_QUESTION_DIFFERS");
    expect(f?.params["differences"]).toContain("0 to 120");
    expect(f?.params["differences"]).toContain("0 to 59");
    // The comparison of results still ran over the ages both drafts accept.
    expect(Number(find(out, "CROSS_CHECK_SUMMARY")?.params["compared"])).toBeGreaterThan(0);
  });

  it("reports a different age range", () => {
    const f = find(crossCheck(ctxWith((m) => { m.scope.age_months_below = 59; })), "CROSS_CHECK_SCOPE_DIFFERS");
    expect(f?.params).toMatchObject({ firstFrom: 2, firstTo: 60, secondFrom: 2, secondTo: 59 });
  });

  it("reports a result only one draft has", () => {
    const out = crossCheck(
      ctxWith((m) => {
        m.outcomes.push({ id: "extra_result", severity: 4, title: "Extra result nobody asked for", actions: [{ text: "Do something", origin: "team" }], follow_up: null, origin: "team" });
      }),
    );
    const f = find(out, "CROSS_CHECK_OUTCOME_ONLY_IN_ONE");
    expect(f?.params).toMatchObject({ draft: "second", outcome: "Extra result nobody asked for", severity: 4 });
  });

  it("reports a different urgency rank, and which way it goes", () => {
    const out = crossCheck(ctxWith((m) => { m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").severity = 2; }));
    const f = find(out, "CROSS_CHECK_SEVERITY_DIFFERS");
    expect(f?.params).toMatchObject({ firstSeverity: 3, secondSeverity: 2, direction: "more_urgent_in_second" });
    const less = crossCheck(ctxWith((m) => { m.outcomes.find((o: any) => o.id === "refer_urgent").severity = 3; }));
    expect(find(less, "CROSS_CHECK_SEVERITY_DIFFERS")?.params["direction"]).toBe("less_urgent_in_second");
  });

  it("reports a different follow-up", () => {
    const f = find(
      crossCheck(ctxWith((m) => { m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").follow_up.due_in_days = 5; })),
      "CROSS_CHECK_FOLLOWUP_DIFFERS",
    );
    expect(f?.params).toMatchObject({ first: "due after 3 days", second: "due after 5 days" });
    expect(String(f?.params["quote"])).toContain("3 days");
  });

  it("reports a different dose by age", () => {
    const f = find(
      crossCheck(ctxWith((m) => { m.outcomes.find((o: any) => o.id === "refer_urgent_with_antibiotic").actions[0].dose_by_age[0].dose = "2 tablets"; })),
      "CROSS_CHECK_DOSE_DIFFERS",
    );
    expect(f?.params["first"]).toContain("2 up to 12 months: 1 tablet");
    expect(f?.params["second"]).toContain("2 up to 12 months: 2 tablets");
  });

  it("reports an action only one draft has, but not a rewording of the same action", () => {
    const added = crossCheck(ctxWith((m) => { m.outcomes.find((o: any) => o.id === "refer_urgent").actions.push({ text: "Give vitamin A", origin: "team" }); }));
    expect(find(added, "CROSS_CHECK_ACTION_DIFFERS")?.params["onlySecond"]).toContain("Give vitamin A");
    const reworded = crossCheck(
      ctxWith((m) => {
        const a = m.outcomes.find((o: any) => o.id === "refer_urgent").actions[0];
        a.text = a.text + " now";
      }),
    );
    expect(find(reworded, "CROSS_CHECK_ACTION_DIFFERS")).toBeUndefined();
  });

  it("reports an open question only one draft raised", () => {
    const out = crossCheck(
      ctxWith((m) => {
        m.open_questions.push({ id: "Q9", question: "Is a child with a chest infection and HIV covered by this form at all?", affects: [], route_to: "clinician", status: "open" });
      }),
    );
    const f = find(out, "CROSS_CHECK_OPEN_QUESTION_ONLY_IN_ONE");
    expect(f?.params).toMatchObject({ draft: "second", route: "clinician" });
    expect(all(out, "CROSS_CHECK_OPEN_QUESTION_ONLY_IN_ONE")).toHaveLength(1);
  });
});

describe("crossCheck: limits and gates", () => {
  it("says so when there are too many combinations to compare child by child, and still reports the structure", () => {
    const out = crossCheck(ctxWith((m) => changeCutoff(m, 50, 40), { maxGridPoints: 10 }));
    expect(find(out, "CROSS_CHECK_NOT_COMPARED")).toBeDefined();
    expect(find(out, "CROSS_CHECK_CUTOFF_DIFFERS")).toBeDefined();
    expect(find(out, "CROSS_CHECK_DISAGREEMENT")).toBeUndefined();
    expect(find(out, "CROSS_CHECK_SUMMARY")).toBeUndefined();
  });

  it("is only ever a warning or information, decided by the clinician, so signing is never blocked by it", () => {
    const base = runChecks(matchedCtx());
    const withSecond = runChecks({ ...matchedCtx(), crossCheck: { model: v1Copy((m) => changeCutoff(m, 50, 40)) } });
    const mine = withSecond.findings.filter((f) => f.check === "crossCheck");
    expect(mine.length).toBeGreaterThan(1);
    for (const f of mine) {
      expect(["warning", "info"]).toContain(f.severity);
      expect(f.decidedBy).toBe("clinician");
    }
    expect(withSecond.blocking).toBe(base.blocking);
    expect(withSecond.gates.canOfficerSign).toBe(base.gates.canOfficerSign);
    expect(withSecond.gates.canClinicianSign).toBe(base.gates.canClinicianSign);
    expect(withSecond.gates.canCompile).toBe(base.gates.canCompile);
  });

  it("does not run the comparison when the first draft is not valid", () => {
    const res = runChecks({ model: { nope: true } as any, crossCheck: { model: v1Copy() } });
    expect(res.ranChecks).not.toContain("crossCheck");
  });
});

describe("crossCheck: messages", () => {
  const many = () =>
    crossCheck(
      ctxWith((m) => {
        changeCutoff(m, 50, 40);
        m.scope.age_months_below = 59;
        m.questions.find((q: any) => q.id === "age_months").constraint.max = 59;
        m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").severity = 2;
        m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").follow_up.due_in_days = 5;
        m.outcomes.find((o: any) => o.id === "refer_urgent_with_antibiotic").actions[0].dose_by_age[0].dose = "2 tablets";
        m.outcomes.find((o: any) => o.id === "refer_urgent").actions.push({ text: "Give vitamin A", origin: "team" });
        m.outcomes.push({ id: "extra_result", severity: 4, title: "Extra result", actions: [{ text: "Do something", origin: "team" }], follow_up: null, origin: "team" });
        m.open_questions.push({ id: "Q9", question: "Is a child with a chest infection and HIV covered by this form at all?", affects: [], route_to: "clinician", status: "open" });
      }),
    );

  it("has a plain-language template for every code the check can raise", () => {
    const codes = new Set(many().map((f) => f.code));
    for (const c of [
      "CROSS_CHECK_SECOND_DRAFT_INVALID", "CROSS_CHECK_NOT_COMPARED", "CROSS_CHECK_SUMMARY", "CROSS_CHECK_DISAGREEMENT", "CROSS_CHECK_QUESTION_ONLY_IN_ONE",
      "CROSS_CHECK_QUESTION_DIFFERS", "CROSS_CHECK_CUTOFF_DIFFERS", "CROSS_CHECK_SCOPE_DIFFERS", "CROSS_CHECK_OUTCOME_ONLY_IN_ONE", "CROSS_CHECK_SEVERITY_DIFFERS",
      "CROSS_CHECK_FOLLOWUP_DIFFERS", "CROSS_CHECK_ACTION_DIFFERS", "CROSS_CHECK_DOSE_DIFFERS", "CROSS_CHECK_OPEN_QUESTION_ONLY_IN_ONE",
    ]) {
      expect(MESSAGE_CODES).toContain(c);
    }
    for (const c of codes) expect(MESSAGE_CODES, c).toContain(c);
  });

  it("renders every finding for both roles, with no jargon, and says that neither draft is assumed right", () => {
    const fs = many();
    expect(fs.length).toBeGreaterThanOrEqual(10);
    for (const f of fs) {
      for (const aud of ["clinician", "program_officer"] as const) {
        const m = render(f.code, f.params, aud);
        expect(m, f.code).not.toMatch(JARGON_RE);
        expect(m.length, f.code).toBeGreaterThan(40);
        expect(m, f.code).not.toMatch(/undefined|NaN|\[object/);
      }
    }
    const d = fs.find((f) => f.code === "CROSS_CHECK_DISAGREEMENT") as Finding;
    expect(render(d.code, d.params, "clinician")).toContain("Neither draft is assumed to be correct");
  });
});
