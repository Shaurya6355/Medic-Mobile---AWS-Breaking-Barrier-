import { describe, expect, it } from "vitest";
import { dangerSignCoverage } from "../../src/validation/checks/dangerSignCoverage.js";
import { codesOf, JARGON_RE, matchedCtx, realExtraction } from "./helpers.js";

const run = (mutate?: (m: any) => void, ext?: (e: any) => void) => dangerSignCoverage({ ...matchedCtx(mutate), extraction: realExtraction(ext) });
const ids = (fs: { subjects: { id: string }[] }[]) => fs.map((f) => f.subjects[0]!.id.replace("danger_sign:", ""));

describe("dangerSignCoverage", () => {
  it("without an extraction nothing is reported (the context notice says so)", () => {
    expect(dangerSignCoverage(matchedCtx())).toEqual([]);
  });

  it("v1.json models 6 of the 13 danger signs; the other 7 are named in its list of left-out items and shown to the clinician", () => {
    const fs = run();
    expect(fs.filter((f) => f.severity === "blocking")).toEqual([]);
    expect(fs.every((f) => f.code === "DANGER_SIGN_EXCLUDED_NOT_COUGH" && f.severity === "info")).toBe(true);
    expect(ids(fs).sort()).toEqual(["ds_blood_stool", "ds_diarrhoea_14d", "ds_fever_7d", "ds_hiv_other_illness", "ds_muac_red", "ds_muac_yellow_hiv", "ds_swelling_feet"]);
    const f = fs.find((x) => x.subjects[0]!.id.endsWith("ds_diarrhoea_14d"))!;
    expect(f.decidedBy).toBe("clinician");
    expect(f.audience[0]).toBe("clinician");
    expect(f.params["coughRelevant"]).toBe(false);
    expect(f.params["openQuestion"]).toBe("Q4");
    expect(f.params["page"]).toBe("6");
    expect(f.message).toContain("Diarrhoea for 14 days or more");
    expect(f.message).toContain("page 6");
    expect(f.message).toContain("Q4");
  });

  it("modelled signs are found by their quote, whatever the line breaks and hyphenation (not able to drink or feed any-thing)", () => {
    expect(ids(run())).not.toContain("ds_cannot_drink_feed");
    expect(ids(run())).not.toContain("ds_sleepy");
    expect(ids(run())).not.toContain("ds_cough_14d");
  });

  it("a danger sign relevant to cough that the draft drops silently blocks, for the clinician", () => {
    const fs = run((m) => { m.questions.find((q: any) => q.id === "convulsions").source = [{ page: 5, quote: "Fits?" }]; });
    const f = fs.find((x) => x.code === "DANGER_SIGN_NOT_MODELLED")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.audience).toEqual(["clinician", "program_officer"]);
    expect(f.subjects[0]!.id).toBe("danger_sign:ds_convulsions");
    expect(f.params["coughRelevant"]).toBe(true);
    expect(f.message).toContain("Convulsions");
    expect(f.message).toContain("page 6");
  });

  it("a sign the extraction marked as not related to cough, and the draft neither models nor names as left out, blocks", () => {
    const fs = run((m) => { m.scope.excluded = m.scope.excluded.filter((e: any) => !/Diarrhoea/.test(e.item)); });
    const b = fs.filter((x) => x.code === "DANGER_SIGN_NOT_MODELLED");
    // that one line of the left-out list named diarrhoea, blood in stool and fever together
    expect(ids(b).sort()).toEqual(["ds_blood_stool", "ds_diarrhoea_14d", "ds_fever_7d"]);
    expect(b[0]!.params["coughRelevant"]).toBe(false);
    expect(b[0]!.params["openQuestion"]).toBe("Q4");
    expect(fs.filter((x) => x.code === "DANGER_SIGN_EXCLUDED_NOT_COUGH")).toHaveLength(4);
  });

  it("naming a sign in the left-out text is enough, even in the reason, in any case", () => {
    const fs = run((m) => { m.scope.excluded = [{ item: "Other pathways", reason: "BLOOD IN STOOL, DIARRHOEA, fever, MUAC, swelling of both feet and HIV are handled elsewhere" }]; });
    expect(fs.filter((x) => x.severity === "blocking")).toEqual([]);
    expect(fs).toHaveLength(7);
  });

  it("a sign the draft covers through a calculated value's quote counts as modelled", () => {
    const fs = run((m) => { m.derived[2].source.push({ page: 6, quote: "Diarrhoea for 14 days or more" }); });
    const d = fs.filter((f) => f.subjects[0]!.id === "danger_sign:ds_diarrhoea_14d");
    // modelled, so neither "not modelled" nor "left out"; but no question asks about it, which blocks
    expect(d.map((f) => f.code)).toEqual(["DANGER_SIGN_QUESTION_UNKNOWN"]);
    expect(fs.filter((f) => f.code === "DANGER_SIGN_EXCLUDED_NOT_COUGH")).toHaveLength(6);
  });

  it("a quote only cited by an open question does not count as modelling the sign", () => {
    // Q4 cites the diarrhoea line; the sign still counts as not modelled
    expect(ids(run())).toContain("ds_diarrhoea_14d");
  });

  it("a cough-relevant sign named as left out blocks: only signs the extraction marked as not related to cough may be left out (M91)", () => {
    const fs = run((m) => {
      m.derived[2].definition.any = m.derived[2].definition.any.filter((x: any) => x.field !== "convulsions");
      m.questions = m.questions.filter((q: any) => q.id !== "convulsions");
      m.scope.excluded.push({ item: "Convulsions", reason: "handled by the referral form" });
    });
    const f = fs.find((x) => x.subjects[0]!.id.endsWith("ds_convulsions"))!;
    expect(f.code).toBe("DANGER_SIGN_EXCLUDED_COUGH_RELEVANT");
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.message).toContain("related to cough");
    expect(f.message).not.toMatch(JARGON_RE);
  });

  it("is deterministic", () => {
    expect(run().map((f) => f.id)).toEqual(run().map((f) => f.id));
  });
});

const DS = (m: any) => m.derived.find((d: any) => d.id === "danger_sign").definition;
const outcome = (m: any, id: string) => m.outcomes.find((o: any) => o.id === id);
const blocking = (fs: { severity: string; code: string }[]) => fs.filter((f) => f.severity === "blocking").map((f) => f.code);

describe("dangerSignCoverage: each danger sign alone leads to urgent referral (red team 1)", () => {
  it("v1 passes: every cough-related danger sign, alone, gets an urgent referral", () => {
    expect(blocking(run())).toEqual([]);
  });

  it("a danger sign dropped from the danger-sign value while its question stays blocks, with the child and the result (M11)", () => {
    const fs = run((m) => { DS(m).any = DS(m).any.filter((x: any) => x.field !== "convulsions"); });
    const f = fs.find((x) => x.code === "DANGER_SIGN_NOT_URGENT")!;
    expect(f.severity).toBe("blocking");
    expect(f.decidedBy).toBe("clinician");
    expect(f.subjects).toContainEqual({ kind: "scope", id: "danger_sign:ds_convulsions" });
    expect(f.subjects).toContainEqual({ kind: "question", id: "convulsions" });
    expect(f.message).toContain("Convulsions");
    expect(f.message).toContain("No cough: this form does not apply");
    expect(f.message).toMatch(/a child aged \d+ months/);
    expect(f.message).toContain("page 6");
    expect(f.message).not.toMatch(JARGON_RE);
    expect(f.example).toMatchObject({ convulsions: true });
  });

  it("a danger sign routed to a mild result blocks (M12), and so does chest indrawing alone (M13)", () => {
    expect(blocking(run((m) => {
      DS(m).any = DS(m).any.filter((x: any) => x.field !== "convulsions");
      m.rules.find((r: any) => r.id === "R5").when = { any: [{ field: "cough", op: "is_yes" }, { field: "convulsions", op: "is_yes" }] };
    }))).toContain("DANGER_SIGN_NOT_URGENT");
    const fs = run((m) => { DS(m).any = DS(m).any.filter((x: any) => x.field !== "chest_indrawing"); });
    expect(fs.filter((f) => f.code === "DANGER_SIGN_NOT_URGENT").map((f) => f.subjects.find((x) => x.kind === "scope")!.id)).toEqual(["danger_sign:ds_chest_indrawing"]);
  });

  it("danger signs counted only for children with cough block (M80)", () => {
    const fs = run((m) => { const d = m.derived.find((x: any) => x.id === "danger_sign"); d.definition = { all: [{ field: "cough", op: "is_yes" }, d.definition] }; });
    const signs = fs.filter((f) => f.code === "DANGER_SIGN_NOT_URGENT").map((f) => f.subjects.find((x) => x.kind === "scope")!.id).sort();
    expect(signs).toEqual(["danger_sign:ds_cannot_drink_feed", "danger_sign:ds_chest_indrawing", "danger_sign:ds_convulsions", "danger_sign:ds_sleepy", "danger_sign:ds_vomits_everything"]);
  });

  it("the chronic-cough sign is tested at the booklet's 14 days, not at the draft's cut-off (M07, M08)", () => {
    expect(blocking(run((m) => { DS(m).any[0].all[1].op = "less_than"; }))).toContain("DANGER_SIGN_NOT_URGENT");
    expect(blocking(run((m) => { DS(m).any[0].all[1].value = 15; }))).toContain("DANGER_SIGN_NOT_URGENT");
  });

  it("a danger-sign question asked only for some children blocks (M89); cough days asked only with cough is fine", () => {
    const fs = run((m) => {
      m.questions.find((q: any) => q.id === "convulsions").shown_when = { field: "cough", op: "is_yes" };
      const i = DS(m).any.findIndex((x: any) => x.field === "convulsions");
      DS(m).any[i] = { all: [{ field: "cough", op: "is_yes" }, { field: "convulsions", op: "is_yes" }] };
    });
    const f = fs.find((x) => x.code === "DANGER_SIGN_ASKED_ONLY_SOMETIMES")!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "question", id: "convulsions" });
    expect(f.message).toContain("cough");
    expect(codesOf(run())).not.toContain("DANGER_SIGN_ASKED_ONLY_SOMETIMES");
  });

  it("a danger sign that the entry limits make impossible to record blocks (M53)", () => {
    const fs = run((m) => { m.questions.find((q: any) => q.id === "cough_days").constraint.max = 13; });
    const f = fs.find((x) => x.code === "DANGER_SIGN_CANNOT_BE_RECORDED")!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "scope", id: "danger_sign:ds_cough_14d" });
  });

  it("the result a danger sign leads to must tell the health worker to refer, whatever its ranking (M33)", () => {
    const fs = run((m) => {
      const o = outcome(m, "refer_urgent");
      o.title = "Danger sign: advise fluids at home";
      o.actions = structuredClone(outcome(m, "cough_no_fast_breathing").actions);
    });
    const f = fs.find((x) => x.code === "DANGER_SIGN_OUTCOME_NO_REFERRAL")!;
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toContainEqual({ kind: "outcome", id: "refer_urgent" });
    expect(f.message).toContain("advise fluids at home");
  });

  it("a referral ranked below the most urgent result blocks (M19)", () => {
    expect(blocking(run((m) => { outcome(m, "refer_urgent").severity = 4; }))).toContain("DANGER_SIGN_NOT_URGENT");
  });

  it("a modelled sign whose question cannot be found blocks instead of passing unchecked", () => {
    const fs = run((m) => {
      const q = m.questions.find((x: any) => x.id === "convulsions");
      q.id = "fits";
      q.label = "Fits?";
      q.source = [{ page: 5, quote: "Fits?" }];
      for (const x of DS(m).any) if (x.field === "convulsions") x.field = "fits";
      m.derived.find((d: any) => d.id === "danger_sign").source.push({ page: 6, quote: "Convulsions" });
    });
    expect(codesOf(fs)).toContain("DANGER_SIGN_QUESTION_UNKNOWN");
  });
});
