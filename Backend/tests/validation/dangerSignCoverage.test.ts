import { describe, expect, it } from "vitest";
import { dangerSignCoverage } from "../../src/validation/checks/dangerSignCoverage.js";
import { matchedCtx, realExtraction } from "./helpers.js";

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
    const fs = run((m) => { m.derived[1].source.push({ page: 6, quote: "Diarrhoea for 14 days or more" }); });
    expect(ids(fs)).not.toContain("ds_diarrhoea_14d");
    expect(fs).toHaveLength(6);
  });

  it("a quote only cited by an open question does not count as modelling the sign", () => {
    // Q4 cites the diarrhoea line; the sign still counts as not modelled
    expect(ids(run())).toContain("ds_diarrhoea_14d");
  });

  it("a cough-relevant sign named as left out is still shown to the clinician, with the extraction's judgment", () => {
    const fs = run((m) => {
      m.questions.find((q: any) => q.id === "convulsions").source = [{ page: 5, quote: "Fits?" }];
      m.scope.excluded.push({ item: "Convulsions", reason: "handled by the referral form" });
    });
    const f = fs.find((x) => x.subjects[0]!.id.endsWith("ds_convulsions"))!;
    expect(f.code).toBe("DANGER_SIGN_EXCLUDED_NOT_COUGH");
    expect(f.params["coughRelevant"]).toBe(true);
    expect(f.message).toContain("related to cough");
  });

  it("is deterministic", () => {
    expect(run().map((f) => f.id)).toEqual(run().map((f) => f.id));
  });
});
