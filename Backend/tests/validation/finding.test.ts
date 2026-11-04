import { describe, expect, it } from "vitest";
import { FindingSchema, loadSourceDocument, makeFinding } from "../../src/validation/finding.js";
import { realDocument, realDocumentRaw } from "./helpers.js";

const base = {
  check: "quoteGrounding",
  code: "HALLUCINATED_CITATION",
  severity: "blocking" as const,
  audience: ["program_officer" as const, "clinician" as const],
  decidedBy: "program_officer" as const,
  subjects: [{ kind: "rule" as const, id: "R1" }],
  params: { item: 'the rule "R1"', page: "7", quote: "x", blockText: "y" },
  source: [{ page: 7, quote: "x" }],
};

describe("makeFinding", () => {
  it("builds a schema-valid finding with a sha256 hex id", () => {
    const f = makeFinding(base);
    expect(FindingSchema.safeParse(f).success).toBe(true);
    expect(f.id).toMatch(/^[0-9a-f]{64}$/);
    expect(f.origin).toBe("deterministic");
    expect(f.message.length).toBeGreaterThan(20);
  });
  it("id is stable and independent of subject order", () => {
    const a = makeFinding({ ...base, subjects: [{ kind: "rule", id: "R1" }, { kind: "outcome", id: "o1" }] });
    const b = makeFinding({ ...base, subjects: [{ kind: "outcome", id: "o1" }, { kind: "rule", id: "R1" }] });
    expect(a.id).toBe(b.id);
  });
  it("id changes when the params change", () => {
    expect(makeFinding(base).id).not.toBe(makeFinding({ ...base, params: { ...base.params, page: "8" } }).id);
  });
  it("accepts every v1 subject kind and rejects the old ones", () => {
    for (const kind of ["question", "derived", "outcome", "action", "follow_up", "rule", "scope", "open_question", "document"] as const) {
      expect(() => makeFinding({ ...base, subjects: [{ kind, id: "x" }] })).not.toThrow();
    }
    for (const kind of ["variable", "table", "clinical_text", "followup"]) {
      expect(() => makeFinding({ ...base, subjects: [{ kind: kind as never, id: "x" }] })).toThrow();
    }
  });
});

describe("loadSourceDocument", () => {
  const sha = "a".repeat(64);
  it("keeps the file hash and groups blocks by page", () => {
    const d = loadSourceDocument({
      doc_sha256: sha,
      pages: [
        { pdf_page: 7, blocks: [{ block_id: "p7.b1", text: "hello" }, { block_id: "p7.b2", text: "world" }] },
        { pdf_page: 8, blocks: [] },
      ],
    });
    expect(d.docSha256).toBe(sha);
    expect(d.pages.get(7)?.map((b) => b.id)).toEqual(["p7.b1", "p7.b2"]);
    expect(d.pageText(7)).toBe("hello\nworld");
    expect(d.pageText(8)).toBe("");
    expect(d.pageText(9)).toBeUndefined();
  });
  it("loads the real extraction: 12 pages, hash, text on page 8", () => {
    const d = realDocument();
    expect(d.docSha256).toBe(realDocumentRaw().doc_sha256);
    expect(d.pages.size).toBe(12);
    expect(d.pageText(8)).toMatch(/breaths/i);
  });
  it("rejects a malformed document, a missing or bad hash and duplicate block ids", () => {
    expect(() => loadSourceDocument({ doc_sha256: sha, pages: [{ pdf_page: "x", blocks: [] }] })).toThrow();
    expect(() => loadSourceDocument({ nope: 1 })).toThrow();
    expect(() => loadSourceDocument({ pages: [] })).toThrow();
    expect(() => loadSourceDocument({ doc_sha256: "xyz", pages: [] })).toThrow();
    expect(() =>
      loadSourceDocument({
        doc_sha256: sha,
        pages: [{ pdf_page: 1, blocks: [{ block_id: "p1.b1", text: "a" }, { block_id: "p1.b1", text: "b" }] }],
      }),
    ).toThrow();
  });
});
