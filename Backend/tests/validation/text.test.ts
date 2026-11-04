import { describe, expect, it } from "vitest";
import { normalizeForQuote, quoteMatches } from "../../src/validation/text.js";

describe("normalizeForQuote", () => {
  it("collapses whitespace and folds case", () => {
    expect(normalizeForQuote("  Hello \n\t WORLD ")).toBe("hello world");
  });
  it("normalizes dashes and quotes", () => {
    expect(normalizeForQuote("12 months—it’s “ok”")).toBe("12 months-it's \"ok\"");
  });
  it("rejoins end-of-line hyphenation", () => {
    expect(normalizeForQuote("not able to drink or feed any-\nthing")).toBe("not able to drink or feed anything");
  });
  it("applies NFC", () => {
    expect(normalizeForQuote("é")).toBe("é");
  });
});

describe("quoteMatches", () => {
  it("matches exact substrings", () => {
    expect(quoteMatches("50 breaths", "In a child,\n50 breaths or more")).toBe(true);
  });
  it("matches across line breaks and case", () => {
    expect(quoteMatches("count breaths in 1 minute: ___ breaths per minute", " If cough, count breaths in 1 minute: ___ breaths per\nminute (bpm).")).toBe(true);
  });
  it("matches spaced-letter text in both directions", () => {
    expect(quoteMatches("NO DANGER SIGN", "SICK BUT N O D ANGER S IGN")).toBe(true);
    expect(quoteMatches("N O D ANGER S IGN", "sick but no danger sign")).toBe(true);
  });
  it("matches hyphenation either way", () => {
    expect(quoteMatches("any-thing", "feed any-\nthing")).toBe(true);
    expect(quoteMatches("anything", "feed any-\nthing")).toBe(true);
  });
  it("rejects altered text and empty quotes", () => {
    expect(quoteMatches("40 breaths or more", "50 breaths or more")).toBe(false);
    expect(quoteMatches("   ", "anything")).toBe(false);
    expect(quoteMatches("", "anything")).toBe(false);
  });
});
