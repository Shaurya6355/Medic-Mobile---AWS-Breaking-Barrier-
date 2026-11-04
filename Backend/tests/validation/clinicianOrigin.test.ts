import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseModel, type Model } from "../../src/logic/index.js";
import { numberGrounding } from "../../src/validation/checks/numberGrounding.js";
import { clinicalText } from "../../src/validation/checks/clinicalText.js";
import { realDocument } from "./helpers.js";

/** The final model, read directly, with one follow-up (3 days) changed in memory. */
function model(origin: "guideline" | "team" | "clinician", quote?: string): Model {
  const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/logic/v1.json"), "utf8"));
  const r = parseModel(raw);
  if (!r.ok) throw new Error(r.issues.join("; "));
  const m = structuredClone(r.value) as any;
  const doc = realDocument();
  m.meta.guideline.file_sha256 = doc.docSha256;
  const f = m.outcomes.find((o: any) => o.id === "treat_fast_breathing_at_home").follow_up;
  f.origin = origin;
  if (quote === undefined) delete f.source;
  else f.source = [{ page: 9, quote }];
  return m as Model;
}

const run = (m: Model) => numberGrounding({ model: m, document: realDocument() });
const forItem = (m: Model, code: string) => run(m).filter((f) => f.code === code && f.subjects.some((s) => s.id === "treat_fast_breathing_at_home"));

describe("clinician-origin values", () => {
  it("a clinician item with no quote is not ungrounded; it is one CLINICIAN_VALUE info that names the origin", () => {
    const m = model("clinician");
    expect(forItem(m, "UNGROUNDED_NUMBER")).toEqual([]);
    const c = forItem(m, "CLINICIAN_VALUE");
    expect(c).toHaveLength(1);
    expect(c[0]!.severity).toBe("info");
    expect(c[0]!.message).toContain("clinician");
    expect(c[0]!.message).toContain("3 days");
    expect(forItem(m, "TEAM_VALUE")).toEqual([]);
    expect(run(m).filter((f) => f.severity === "blocking" && f.subjects.some((s) => s.id === "treat_fast_breathing_at_home" && s.kind !== "outcome"))).toEqual([]);
  });
  it("the same item as guideline with a quote that lacks the number still blocks", () => {
    const m = model("guideline", "Follow up child on return.");
    expect(run(m).some((f) => f.severity === "blocking" && f.subjects.some((s) => s.id === "treat_fast_breathing_at_home"))).toBe(true);
    expect(forItem(m, "CLINICIAN_VALUE")).toEqual([]);
  });
  it("a clinician item that cites a quote without the number is still checked", () => {
    const m = model("clinician", "Follow up child on return.");
    expect(forItem(m, "CLINICIAN_VALUE")).toEqual([]);
    expect(run(m).some((f) => f.severity === "blocking" && f.subjects.some((s) => s.id === "treat_fast_breathing_at_home"))).toBe(true);
  });
  it("the same item as team keeps its TEAM_VALUE behaviour and gets no CLINICIAN_VALUE", () => {
    const m = model("team");
    expect(forItem(m, "TEAM_VALUE")).toHaveLength(1);
    expect(forItem(m, "CLINICIAN_VALUE")).toEqual([]);
    expect(forItem(m, "UNGROUNDED_NUMBER")).toEqual([]);
  });
  it("clinician wording is not listed as team text to confirm", () => {
    const m = model("guideline", "x") as any;
    const o = m.outcomes.find((x: any) => x.id === "no_cough");
    const before = clinicalText({ model: m, document: realDocument() }).filter((f) => f.code === "TEAM_TEXT_TO_CONFIRM" && f.subjects[0]!.id === "no_cough");
    expect(before).toHaveLength(1);
    for (const a of o.actions) if (a.origin === "team") { a.origin = "clinician"; delete a.source; }
    const after = clinicalText({ model: m, document: realDocument() }).filter((f) => f.code === "TEAM_TEXT_TO_CONFIRM" && f.subjects[0]!.id === "no_cough");
    expect(after).toEqual([]);
  });

  describe("numbers in the text of a clinician item", () => {
    const OUT = "treat_fast_breathing_at_home";
    /** The outcome's first action gets a number the booklet quote does not have. */
    function withText(origin: "guideline" | "team" | "clinician", quote?: string): Model {
      const m = model("guideline", "Follow up child on return. 3 days") as any;
      const o = m.outcomes.find((x: any) => x.id === OUT);
      const a = o.actions[0];
      a.text = "Come back after 11 days.";
      a.origin = origin;
      if (quote === undefined) delete a.source;
      else a.source = [{ page: 9, quote }];
      return m as Model;
    }
    const textFindings = (m: Model, code: string) => run(m).filter((f) => f.code === code && f.subjects.some((s) => s.id === OUT || s.id.startsWith(`${OUT}/`)));
    it("no quote: no blocker, one CLINICIAN_VALUE info naming the number", () => {
      const m = withText("clinician");
      expect(textFindings(m, "NUMBER_IN_TEXT_UNSUPPORTED")).toEqual([]);
      const c = textFindings(m, "CLINICIAN_VALUE");
      // One finding per owner: the action's dose-table numbers and its text numbers are listed together.
      expect(c).toHaveLength(1);
      expect(c[0]!.severity).toBe("info");
      expect(c[0]!.message).toContain("11 days");
      expect(c[0]!.message).toContain("tablet");
    });
    it("a result title the clinician wrote shares one CLINICIAN_VALUE with its numeric follow-up", () => {
      const m = withText("guideline", "Follow up child on return. 11 days") as any;
      const o = m.outcomes.find((x: any) => x.id === OUT);
      o.origin = "clinician";
      delete o.source;
      o.title = "Come back in 9 days";
      for (const a of o.actions) delete a.source;
      o.follow_up.origin = "clinician";
      delete o.follow_up.source;
      expect(textFindings(m, "NUMBER_IN_TEXT_UNSUPPORTED").filter((f) => f.subjects.some((s) => s.kind === "outcome"))).toEqual([]);
      const c = textFindings(m, "CLINICIAN_VALUE").filter((f) => f.subjects.some((s) => s.kind === "outcome"));
      expect(c).toHaveLength(1);
      expect(c[0]!.message).toContain("9 days");
      expect(c[0]!.message).toContain("3 days");
    });
    it("a clinician item that cites a quote without the number still blocks", () => {
      const m = withText("clinician", "Follow up child on return.");
      expect(textFindings(m, "NUMBER_IN_TEXT_UNSUPPORTED").length).toBeGreaterThan(0);
      expect(textFindings(m, "CLINICIAN_VALUE")).toEqual([]);
    });
    it("guideline and team text with the same number still block", () => {
      expect(textFindings(withText("team"), "NUMBER_IN_TEXT_UNSUPPORTED").length).toBeGreaterThan(0);
      expect(textFindings(withText("guideline", "Follow up child on return."), "NUMBER_IN_TEXT_UNSUPPORTED").length).toBeGreaterThan(0);
    });
  });
});
