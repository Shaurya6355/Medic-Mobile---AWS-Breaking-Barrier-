import { describe, expect, it } from "vitest";
import { quoteGrounding } from "../../src/validation/checks/quoteGrounding.js";
import { loadSourceDocument } from "../../src/validation/finding.js";
import type { CheckContext } from "../../src/validation/finding.js";
import { realCtx, realDocumentRaw, syntheticDocument, v1Copy } from "./helpers.js";

const codes = (c: CheckContext) => quoteGrounding(c).map((f) => f.code);

/** v1 with every cited source replaced by one source, to test normalisation on the synthetic booklet. */
function oneSource(page: number, quote: string): CheckContext {
  const src = [{ page, quote }];
  const model = v1Copy((m) => {
    m.questions.forEach((q: any) => (q.source = src));
    m.derived.forEach((d: any) => (d.source = src));
    m.outcomes.forEach((o: any) => {
      o.source = src;
      o.actions.forEach((a: any) => (a.source = src));
      if (o.follow_up) o.follow_up.source = src;
    });
    m.rules.forEach((r: any) => (r.source = src));
    m.open_questions.forEach((q: any) => (q.source = src));
    m.scope.source = src;
  });
  return { model, document: syntheticDocument() };
}

describe("quoteGrounding on the real booklet", () => {
  it("every quote in v1.json is found on the page it cites", () => {
    expect(quoteGrounding(realCtx())).toEqual([]);
  });

  it("flags a changed quote on a question, naming the item kind and the page", () => {
    const fs = quoteGrounding(realCtx((m) => { m.questions[0].source[0].quote = "child age 3 months up to 5 years"; }));
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.code).toBe("HALLUCINATED_CITATION");
    expect(f.severity).toBe("blocking");
    expect(f.subjects).toEqual([{ kind: "question", id: "age_months" }]);
    expect(f.params["page"]).toBe("3");
    expect(f.message).toContain("question");
    expect(f.message).toContain("page 3");
    expect(f.message).toContain("child age 3 months up to 5 years");
    expect(f.source).toEqual([{ page: 3, quote: "child age 3 months up to 5 years" }]);
  });

  it("flags a quote cited on the wrong page", () => {
    const fs = quoteGrounding(realCtx((m) => { m.questions[1].source[0].page = 3; }));
    expect(fs.map((f) => f.code)).toEqual(["HALLUCINATED_CITATION"]);
    expect(fs[0]!.params["page"]).toBe("3");
  });

  it("flags a page that is not in the document", () => {
    const fs = quoteGrounding(realCtx((m) => { m.derived[1].source[0].page = 99; }));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.code).toBe("SOURCE_PAGE_MISSING");
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.subjects).toEqual([{ kind: "derived", id: "fast_breathing" }]);
    expect(fs[0]!.message).toContain("99");
  });

  it("names every kind of item", () => {
    const bad = "words that are not in the booklet";
    const kindOf = (mutate: (m: any) => void) => quoteGrounding(realCtx(mutate)).map((f) => f.subjects[0]!.kind);
    expect(kindOf((m) => { m.derived[2].source[0].quote = bad; })).toEqual(["derived"]);
    expect(kindOf((m) => { m.outcomes[2].source[0].quote = bad; })).toEqual(["outcome"]);
    expect(kindOf((m) => { m.outcomes[2].actions[0].source[0].quote = bad; })).toEqual(["action"]);
    expect(kindOf((m) => { m.outcomes[2].follow_up.source[0].quote = bad; })).toEqual(["follow_up"]);
    expect(kindOf((m) => { m.rules[2].source[0].quote = bad; })).toEqual(["rule"]);
    expect(kindOf((m) => { m.scope.source[0].quote = bad; })).toEqual(["scope"]);
    expect(kindOf((m) => { m.open_questions[0].source[0].quote = bad; })).toEqual(["open_question"]);
  });

  it("checks every one of several sources", () => {
    const fs = quoteGrounding(realCtx((m) => {
      m.questions[0].source.push({ page: 3, quote: "an invented second quote" });
    }));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.params["quote"]).toBe("an invented second quote");
  });

  it("flags an empty quote", () => {
    const fs = quoteGrounding(realCtx((m) => { m.questions[0].source[0].quote = "   "; }));
    expect(fs.map((f) => f.code)).toEqual(["EMPTY_QUOTE"]);
    expect(fs[0]!.severity).toBe("blocking");
  });

  it("reports a missing document once, blocking, for the program officer", () => {
    const fs = quoteGrounding({ model: realCtx().model });
    expect(fs.map((f) => f.code)).toEqual(["SOURCE_DOCUMENT_MISSING"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.audience).toEqual(["program_officer"]);
  });

  it("is deterministic", () => {
    const run = () => quoteGrounding(realCtx((m) => { m.rules[2].source[0].quote = "invented"; })).map((f) => f.id);
    expect(run()).toEqual(run());
  });
});

describe("quoteGrounding normalisation against page text", () => {
  it("passes quotes that differ in case, line breaks, dashes and spacing", () => {
    expect(codes(oneSource(7, "CHILD  age 2 months\nup to 5 years"))).toEqual([]);
    expect(codes(oneSource(8, "age 2 months up to 12 months - 1 tablet"))).toEqual([]);
    expect(codes(oneSource(7, "If cough, count breaths in 1 minute: ___ breaths per minute (bpm)."))).toEqual([]);
  });
  it("passes end-of-line hyphenation and spaced-letter text", () => {
    expect(codes(oneSource(7, "not able to drink or feed anything"))).toEqual([]);
    expect(codes(oneSource(7, "NO DANGER SIGN"))).toEqual([]);
  });
  it("A3/A22: never stitches a quote across two blocks of the same page", () => {
    expect(codes(oneSource(7, "Child age 2 months up to 5 years If cough, count breaths"))).toContain("HALLUCINATED_CITATION");
  });
  it("does not let a quote borrow text from another page", () => {
    expect(codes(oneSource(8, "Child age 2 months up to 5 years")).length).toBeGreaterThan(0);
  });
  it("loads a real-document copy with the page text altered, and the quote then fails", () => {
    const raw = realDocumentRaw();
    for (const p of raw.pages) for (const b of p.blocks) b.text = b.text.replace(/2 months up to 5 years/g, "2 months up to 6 years");
    const ctx = { model: realCtx().model, document: loadSourceDocument(raw) };
    expect(quoteGrounding(ctx).length).toBeGreaterThan(0);
  });
});

describe("quoteGrounding hardening (red team 2)", () => {
  it("A2/A21: a trivial quote (a page number, one short word) is blocking QUOTE_TOO_SHORT", () => {
    const fs = quoteGrounding(realCtx((m) => { m.questions[0].source[0] = { page: 8, quote: "8" }; }));
    expect(fs.map((f) => f.code)).toEqual(["QUOTE_TOO_SHORT"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.message).toContain('"8"');
    expect(codes({ model: realCtx((m) => { m.questions[0].source[0] = { page: 8, quote: "the" }; }).model, document: realCtx().document! })).toEqual(["QUOTE_TOO_SHORT"]);
  });
  it("A6: a quote that leaves out the 'not' in front of it is blocking QUOTE_DROPS_NEGATION", () => {
    const fs = quoteGrounding(realCtx((m) => { m.questions[0].source[0] = { page: 6, quote: "able to drink or feed anything" }; }));
    expect(fs.map((f) => f.code)).toEqual(["QUOTE_DROPS_NEGATION"]);
    expect(fs[0]!.severity).toBe("blocking");
    expect(fs[0]!.decidedBy).toBe("clinician");
    expect(fs[0]!.message).toMatch(/not/i);
  });
  it("A7: a quote cut in the middle of a number is not found", () => {
    expect(quoteGrounding(realCtx((m) => { m.derived[1].source[0] = { page: 8, quote: "0 breaths or more per minute" }; })).map((f) => f.code)).toEqual(["HALLUCINATED_CITATION"]);
  });
  it("A22: a quote joined from two blocks of the real page 7 is not found", () => {
    expect(quoteGrounding(realCtx((m) => { m.questions[0].source[0] = { page: 7, quote: "Write a referral note.\n Arrange transportation" }; })).map((f) => f.code)).toEqual(["HALLUCINATED_CITATION"]);
  });
});
