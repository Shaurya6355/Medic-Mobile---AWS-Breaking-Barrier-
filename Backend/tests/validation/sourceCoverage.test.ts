import { describe, expect, it } from "vitest";
import { sourceCoverage } from "../../src/validation/checks/sourceCoverage.js";
import { loadExtraction } from "../../src/validation/context.js";
import { matchedCtx, realExtraction } from "./helpers.js";

const src = (page: number, quote: string) => [{ block_id: `p${page}.b1`, pdf_page: page, quote }];
const node = (id: string, page: number, quote: string, extra: any = {}) => ({ id, kind: "advice", text: quote, src: src(page, quote), ...extra });
const synth = (nodes: any[], actions: any[] = [], followups: any[] = []) => loadExtraction({ danger_signs: [], nodes, actions, followups });
const run = (ext: ReturnType<typeof synth>, mutate?: (m: any) => void) => sourceCoverage({ ...matchedCtx(mutate), extraction: ext });

describe("sourceCoverage", () => {
  it("without an extraction nothing is reported", () => {
    expect(sourceCoverage(matchedCtx())).toEqual([]);
  });
  it("flags a passage with digits or decision words that no item of the draft quotes", () => {
    const fs = run(synth([node("a", 9, "Give 3 tablets of zinc every day")]));
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("UNCITED_PASSAGE");
    expect(f.severity).toBe("warning");
    expect(f.decidedBy).toBe("program_officer");
    expect(f.audience).toEqual(["program_officer"]);
    expect(f.params["page"]).toBe("9");
    expect(f.params["count"]).toBe(1);
    expect(f.message).toContain("Give 3 tablets of zinc every day");
    expect(f.message).toContain("page 9");
  });
  it("ignores passages without digits or decision words, passages out of scope, and page jumps", () => {
    const fs = run(synth([
      node("a", 9, "Wash your hands well"),
      node("b", 9, "Give 3 tablets", { out_of_scope: true }),
      node("c", 9, "Go to page 10", { kind: "goto" }),
    ]));
    expect(fs).toEqual([]);
  });
  it("each decision word counts", () => {
    for (const w of ["refer the child", "give water", "follow up later", "danger zone", "if sick", "for days", "for months", "one tablet", "7 only"]) {
      expect(run(synth([node("a", 9, w)])), w).toHaveLength(1);
    }
  });
  it("a passage that an item of the draft quotes (either contains the other, whatever the spacing) is covered", () => {
    const m = (x: any) => { x.questions[0].source = [{ page: 3, quote: "Give  3 tablets of zinc every day" }]; };
    expect(run(synth([node("a", 9, "give 3 tablets of ZINC every\nday")]), m)).toEqual([]);
    expect(run(synth([node("a", 9, "Give twice daily for 5 days: Age 2 months up to 12 months")])).length).toBe(0);
  });
  it("is grouped per page and short: one finding per page, at most three examples, with the count", () => {
    const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`, 9, `Give ${i + 1} tablets in the morning`)).concat([node("z", 4, "If sick, refer")]);
    const fs = run(synth(nodes));
    expect(fs.map((f) => f.params["page"])).toEqual(["4", "9"]);
    const p9 = fs[1]!;
    expect(p9.params["count"]).toBe(7);
    expect(p9.message.match(/Give \d tablets/g)).toHaveLength(3);
    expect(p9.message).toContain("7 passages");
  });
  it("actions and follow-ups are covered by the same rule; duplicates of one quote count once", () => {
    const fs = run(synth([node("a", 9, "Give soap")], [{ id: "x", src: src(9, "Give soap") }], [{ id: "y", src: src(9, "Follow up in 2 days") }]));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.params["count"]).toBe(2);
  });
  it("the real extraction against v1.json: grouped warnings for the officer, never more than one per page", () => {
    const fs = run(realExtraction() as any);
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((f) => f.code === "UNCITED_PASSAGE" && f.severity === "warning")).toBe(true);
    const pages = fs.map((f) => f.params["page"]);
    expect(new Set(pages).size).toBe(pages.length);
    expect(fs.length).toBeLessThanOrEqual(8);
  });
  it("is deterministic", () => {
    expect(run(realExtraction() as any).map((f) => f.id)).toEqual(run(realExtraction() as any).map((f) => f.id));
  });
});
