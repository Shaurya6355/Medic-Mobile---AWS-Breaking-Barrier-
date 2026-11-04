import { describe, expect, it } from "vitest";
import { MESSAGE_CODES, render } from "../../src/validation/messages.js";
import { JARGON_RE } from "./helpers.js";

const params = {
  item: 'rule R2, which gives the result "Danger sign: refer urgently"',
  number: 45,
  usage: "45 breaths per minute or more",
  page: "8",
  quote: "50 breaths or more per minute",
  blockText: "In a child age 2 months up to 12 months, 50 breaths or more per minute",
  by: "Dr Test",
  reason: "absent",
  expectedUnit: "breaths per minute",
  textUnits: "months",
  derivation: "60 months is the same as 5 years",
  variable: "Breaths in one minute",
  outcome: "x", target: "x", derived: "d", later: "l", limits: "age: 0 to 120 months",
  expected: "a number", got: "the number 2.5", problem: "it is answered yes or no", where: "w", id: "x", kinds: "rule, question",
  path: "questions[0]", issue: "Required", check: "quoteGrounding", error: "boom", what: "quotes",
  range: "60 up to 62 months", title: "Caring for the sick child", edition: "July 2014", lo: 2, hi: 60,
  count: 3, child: 'a child aged 1 month ("Has the child had convulsions?" yes; all other yes-or-no questions answered no)', winner: "R3", why: "hidden",
  hasFollowUp: true, always: "yes", guard: '"Does the child have a cough?" is answered yes', answer: "50 breaths per minute",
  firstRule: "R1", overriddenRule: "R2", firstOutcome: "Outside the covered ages: refer", overriddenOutcome: "Danger sign: refer urgently", openQuestion: "Q2",
  questions: "Count the child's breaths in 1 minute", from: 11, to: 12, doseBands: "2 up to 13 months, 13 up to 60 months", ruleBands: "2 up to 12 months, 12 up to 60 months",
  name: "inputs", because: "the form uses it to link the report to the child", confirmer: "clinician", texts: '"Continue with the other parts of the assessment."',
  sign: "Convulsions", coughRelevant: true, examples: '"Give 3 tablets"; "If sick, refer"', sourcePhrase: "more than 14 days",
  meaning: "does not include 14 itself", reading: "12 months itself is not included below it, so a child of exactly 12 months counts with the higher group",
  missing: "the form title; the form icon", days: 7, due: 3, description: "6 months, 52 breaths", expectedRule: "R5", ruleOnly: false, note: "awaiting Medic",
  ids: "g01, g02", total: 15, agree: 13, different: 2, needs: "the test cases", checks: "the test-case check", route: "clinician", affects: "R1, R2",
  pageQuote: "", value: -2, rule: "R4", actual: "Treat at home", question: "Is a child of exactly 12 months in the 40-breaths group?",
  threshold: 12, unit: " months", below: "11 months", at: "12 months", above: "13 months", o1: "Cough only", o2: "Treat at home", o3: "Treat at home", bandsMeet: true,
};

const LOGIC_CODES = [
  "TABLE_NOT_CLOSED", "UNCOVERED_ANSWERS", "NOT_PROVEN", "SHADOWED_RULE", "UNREACHABLE_RULE", "UNREACHABLE_OUTCOME", "QUESTION_NEVER_SHOWN", "DERIVED_CONSTANT",
  "DEAD_INPUT", "USE_BEFORE_ASK", "SEVERITY_INVERSION", "SEVERITY_EXCEPTION_APPROVED", "REQUIRED_QUESTION_OPTIONAL", "UNMEASURABLE_NOT_SUPPORTED",
  "AGE_GAP", "AGE_OVERLAP", "OUTSIDE_AGE_BANDS_MISMATCH", "DOSE_BANDS_MISMATCH", "BOUNDARY_SHOWN",
];

const NEW_CODES = [
  "OPEN_QUESTION", "OPEN_QUESTION_NO_RESOLUTION", "RESERVED_FIELD_NAME", "INVALID_FIELD_NAME", "FIELD_RENAMED", "FOLLOWUP_MISSING_OUTCOME",
  "FOLLOWUP_INVALID_DAYS", "FOLLOWUP_RETURN_DAYS_IGNORED", "CLINICAL_TEXT_MISSING", "CLINICAL_TEXT_UNSOURCED", "TEAM_TEXT_TO_CONFIRM",
  "DANGER_SIGN_NOT_MODELLED", "DANGER_SIGN_EXCLUDED_NOT_COUGH", "UNCITED_PASSAGE", "INCLUSIVITY_MISMATCH", "INCLUSIVITY_ASSUMED", "COMPILE_NOT_READY",
  "FOLLOWUP_NOT_COMPILED", "TEAM_DEFAULT_WINDOW", "GOLDEN_MISMATCH", "GOLDEN_INVALID", "GOLDEN_PENDING_CLINICIAN", "OUTCOME_WITHOUT_GOLDEN_CASE",
  "GOLDEN_COUNT", "CONTEXT_NOT_PROVIDED",
];

const JARGON = />=|<=|==|!=|=>|\bAST\b|\bgrid\b|\bjson\b|\bschema\b|\boperator|\bboolean\b|\binteger\b|\bsha\b|\bhash\b|\bchecksum\b|\bfield\b|\bregex\b|undefined|\[object/i;

describe("messages", () => {
  it("has a template for every code listed", () => {
    expect(MESSAGE_CODES.length).toBeGreaterThanOrEqual(20);
    for (const c of ["SOURCE_PAGE_MISSING", "GUIDELINE_FILE_MISMATCH", "TEAM_VALUE", "ENTRY_LIMIT_TEAM_CHOICE", "RELEVANCE_READS_LATER_QUESTION", "DERIVED_CYCLE", "UNKNOWN_AFFECTED_ITEM", "SCOPE_RULE_MISMATCH"]) {
      expect(MESSAGE_CODES).toContain(c);
    }
    for (const c of ["SOURCE_BLOCK_MISSING", "UNKNOWN_ACTION", "UNKNOWN_TARGET", "UNKNOWN_CHOICE", "UNKNOWN_FOLLOWUP_OUTCOME"]) {
      expect(MESSAGE_CODES).not.toContain(c);
    }
    for (const c of ["HALLUCINATED_CITATION", "UNGROUNDED_NUMBER", "UNIT_MISMATCH", "NUMBER_UNIT_CONVERTED", "GUIDELINE_DEVIATION", "EMPTY_QUOTE", "CHECK_CRASHED", "DUPLICATE_ID"]) {
      expect(MESSAGE_CODES).toContain(c);
    }
  });
  it("renders plain language for both audiences with no operators, grid or AST jargon", () => {
    for (const code of MESSAGE_CODES) {
      for (const aud of ["program_officer", "clinician"] as const) {
        const m = render(code, params, aud);
        expect(m, code).not.toMatch(JARGON);
        expect(m.length, code).toBeGreaterThan(40);
        expect(m.length, code).toBeLessThan(900);
      }
    }
  });
  it("says in plain words that the guideline copy differs", () => {
    const m = render("GUIDELINE_FILE_MISMATCH", params, "program_officer");
    expect(m).toContain("different copy of the guideline than the one uploaded");
  });
  it("names the page and the booklet quote and who decides", () => {
    const m = render("UNGROUNDED_NUMBER", params, "clinician");
    expect(m).toContain("page 8");
    expect(m).toContain("50 breaths or more per minute");
    expect(m).toContain("45 breaths per minute or more");
    expect(m).toMatch(/clinician decides/);
  });
  it("differs by audience where the decision path differs", () => {
    expect(render("UNGROUNDED_NUMBER", params, "program_officer")).not.toBe(render("UNGROUNDED_NUMBER", params, "clinician"));
  });
  it("says pages when several are cited", () => {
    expect(render("UNGROUNDED_NUMBER", { ...params, page: "7 and 8" }, "clinician")).toContain("pages 7 and 8");
  });
  it("throws on an unknown code", () => {
    expect(() => render("NOPE", {}, "clinician")).toThrow();
  });
  it("has a template for every logic-analysis code, readable by both audiences, with no jargon", () => {
    for (const c of LOGIC_CODES) {
      expect(MESSAGE_CODES, c).toContain(c);
      const po = render(c, params, "program_officer");
      const cl = render(c, params, "clinician");
      expect(po, c).not.toMatch(JARGON);
      expect(cl, c).not.toMatch(JARGON);
      expect(po, c).not.toMatch(/\$\{|\bundefined\b/);
      expect(cl.length, c).toBeGreaterThan(60);
    }
  });
  it("puts the decision with the clinician for clinical findings and routes them there for the program officer", () => {
    for (const c of ["SEVERITY_INVERSION", "SHADOWED_RULE", "AGE_GAP", "OUTSIDE_AGE_BANDS_MISMATCH", "DOSE_BANDS_MISMATCH", "UNREACHABLE_RULE"]) {
      expect(render(c, params, "clinician"), c).toMatch(/clinician decides/);
      expect(render(c, params, "program_officer"), c).toMatch(/program officer (asks|sends)/);
    }
  });
  it("shows a patient-terms example and the booklet quote where one is given", () => {
    const m = render("SEVERITY_INVERSION", params, "clinician");
    expect(m).toContain("a child aged 1 month");
    expect(m).toContain("Q2");
    expect(m).toContain("page 8");
    expect(m).toContain("50 breaths or more per minute");
  });
  it("does not mention the booklet when no passage is cited, and leaves no double spaces", () => {
    const m = render("USE_BEFORE_ASK", { ...params, page: "", quote: "" }, "program_officer");
    expect(m).not.toMatch(/gives nothing to check/);
    expect(m).not.toMatch(/ {2}/);
  });

  it("has a template for every approval-check code, readable by both audiences, with no jargon", () => {
    for (const c of NEW_CODES) {
      expect(MESSAGE_CODES, c).toContain(c);
      for (const aud of ["program_officer", "clinician"] as const) {
        const m = render(c, params, aud);
        expect(m, `${c} ${aud}`).not.toMatch(JARGON);
        expect(m, `${c} ${aud}`).not.toMatch(JARGON_RE);
        expect(m, `${c} ${aud}`).not.toMatch(/\$\{|\bundefined\b|[A-Z]{2,}_[A-Z_]{2,}/);
        expect(m, `${c} ${aud}`).not.toMatch(/ {2}/);
        expect(m.length, `${c} ${aud}`).toBeGreaterThan(60);
        expect(m.length, `${c} ${aud}`).toBeLessThan(900);
      }
    }
  });
  it("names who decides in every approval-check message", () => {
    for (const c of NEW_CODES) {
      expect(render(c, params, "clinician"), c).toMatch(/clinician|program officer/);
    }
  });
  it("shows page and quote where the booklet is involved", () => {
    for (const c of ["DANGER_SIGN_NOT_MODELLED", "DANGER_SIGN_EXCLUDED_NOT_COUGH", "INCLUSIVITY_MISMATCH", "INCLUSIVITY_ASSUMED", "OPEN_QUESTION"]) {
      const m = render(c, params, "clinician");
      expect(m, c).toContain("page 8");
      expect(m, c).toContain("50 breaths or more per minute");
    }
  });
  it("gives patient terms for the cut-off findings", () => {
    expect(render("INCLUSIVITY_MISMATCH", { ...params, number: 14, unit: " days" }, "clinician")).toContain("child with exactly 14 days");
    expect(render("INCLUSIVITY_ASSUMED", params, "clinician")).toContain("a child of exactly 12 months");
  });
  it("the quote-only number finding names the passage to add, for the program officer", () => {
    const m = render("UNGROUNDED_NUMBER", { ...params, pageQuote: "In a child age 12 months up to 5 years, 40 breaths or more per minute" }, "program_officer");
    expect(m).toContain("adds that passage as a further quote");
    expect(m).toContain("40 breaths or more per minute");
    expect(render("UNGROUNDED_NUMBER", { ...params, pageQuote: "" }, "clinician")).toMatch(/nor on the cited page/);
  });
  it("routes an open question to the right person", () => {
    expect(render("OPEN_QUESTION", { ...params, route: "program_officer" }, "program_officer")).toMatch(/The program officer decides the answer/);
    expect(render("OPEN_QUESTION", params, "clinician")).toMatch(/The clinician decides the answer/);
    expect(render("OPEN_QUESTION", params, "clinician")).toContain("exactly 12 months");
  });
  it("a rename asks the clinician or the program officer, each in their own words", () => {
    expect(render("FIELD_RENAMED", params, "clinician")).toMatch(/clinician confirms/);
    expect(render("FIELD_RENAMED", { ...params, confirmer: "program_officer" }, "program_officer")).toMatch(/program officer confirms/);
  });
  it("test cases: a rule-only difference reads differently from a result difference", () => {
    const a = render("GOLDEN_MISMATCH", params, "clinician");
    const b = render("GOLDEN_MISMATCH", { ...params, ruleOnly: true }, "clinician");
    expect(a).toContain("expects");
    expect(b).toContain("instead of");
    expect(a).not.toBe(b);
  });
});
