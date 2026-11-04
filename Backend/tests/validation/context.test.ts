import { describe, expect, it } from "vitest";
import { loadExtraction, loadGoldenCases } from "../../src/validation/context.js";
import { rawExtraction, rawGoldenCases } from "./helpers.js";

describe("loadExtraction", () => {
  it("reads the real extraction: 13 danger signs with pages and quotes", () => {
    const e = loadExtraction(rawExtraction());
    expect(e.danger_signs).toHaveLength(13);
    expect(e.danger_signs[0]).toMatchObject({ id: "ds_cough_14d", cough_relevant: true });
    expect(e.danger_signs[0]!.src[0]).toEqual({ block_id: "p6.b4", pdf_page: 6, quote: "Cough for 14 days or more" });
    expect(e.nodes.length).toBeGreaterThan(30);
    expect(e.actions.length).toBe(5);
    expect(e.followups.length).toBe(3);
  });
  it("accepts a file with only danger signs and nodes", () => {
    const e = loadExtraction({ danger_signs: [], nodes: [] });
    expect(e.actions).toEqual([]);
    expect(e.followups).toEqual([]);
  });
  it("rejects a danger sign without id or a source without quote", () => {
    expect(() => loadExtraction({ danger_signs: [{ text: "x", cough_relevant: true, src: [] }], nodes: [] })).toThrow();
    expect(() => loadExtraction({ danger_signs: [{ id: "a", text: "x", cough_relevant: true, src: [{ block_id: "b", pdf_page: 1 }] }], nodes: [] })).toThrow();
    expect(() => loadExtraction(42)).toThrow();
  });
});

describe("loadGoldenCases", () => {
  it("reads the proposed cases", () => {
    const g = loadGoldenCases(rawGoldenCases());
    expect(g.length).toBeGreaterThanOrEqual(14);
    expect(g[0]).toMatchObject({ id: "g01", expected_outcome: "treat_fast_breathing_at_home", expected_rule: "R5" });
  });
  it("rejects duplicate ids and cases without an expected outcome", () => {
    const c = { id: "a", description: "d", answers: { x: 1 }, expected_outcome: "o" };
    expect(() => loadGoldenCases([c, c])).toThrow(/duplicate/);
    expect(() => loadGoldenCases([{ ...c, expected_outcome: undefined }])).toThrow();
  });
});
