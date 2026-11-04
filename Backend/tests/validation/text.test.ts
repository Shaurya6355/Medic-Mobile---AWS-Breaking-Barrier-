import { describe, expect, it } from "vitest";
import { hasNegation, isVerbatim, matchOnPage, matchQuote, normalizeForQuote, quoteMatches } from "../../src/validation/text.js";

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

describe("matchQuote hardening (red team 2)", () => {
  it("A2/A1b: trivial quotes (one short word or a bare number) never match", () => {
    expect(matchQuote("8", "Go to page 8")).toBe("too_short");
    expect(matchQuote("the", "the child")).toBe("too_short");
    expect(matchQuote("a", "a child")).toBe("too_short");
    expect(quoteMatches("1", "1 tablet")).toBe(false);
    // two words, or one word of 8 letters or more, is enough
    expect(quoteMatches("Convulsions", "Convulsions?")).toBe(true);
    expect(quoteMatches("1 tablet", "Age 2 months up to 12 months—1 tablet")).toBe(true);
  });
  it("A6/A7: the quote must start and end on a word or number boundary", () => {
    expect(quoteMatches("0 breaths or more per minute", "50 breaths or more per minute")).toBe(false);
    expect(quoteMatches("reaths or more", "50 breaths or more")).toBe(false);
    expect(quoteMatches("50 breaths or mo", "50 breaths or more")).toBe(false);
    expect(quoteMatches("5 tablets now", "give 1.5 tablets now")).toBe(false);
  });
  it("A6/A18: a negation just before the quoted words flags it", () => {
    expect(matchQuote("able to drink or feed", "Not able to drink or feed any-\nthing")).toBe("negated");
    expect(matchQuote("hot with fever", "keep child warm, if child is NOT hot with fever")).toBe("negated");
    expect(matchQuote("danger sign here", "if no danger sign here")).toBe("negated");
    expect(matchQuote("fast breathing", "cough without fast breathing")).toBe("negated");
    expect(matchQuote("able to drink", "un-able to drink")).toBe("negated");
    // the negation itself quoted is fine
    expect(quoteMatches("Not able to drink or feed", "Not able to drink or feed any-\nthing")).toBe(true);
    // an un-negated copy elsewhere in the block is fine
    expect(quoteMatches("able to drink", "not able to drink. If able to drink, give fluids")).toBe(true);
  });
  it("A4/A5/B13: the squash fallback only joins letters, never digits", () => {
    expect(quoteMatches("coughfor14daysormore", "Cough for 14 days or more")).toBe(false);
    expect(quoteMatches("Cough for 1 4 days or more", "Cough for 14 days or more")).toBe(false);
    expect(quoteMatches("212 months", "2-12 months")).toBe(false);
    expect(quoteMatches("2 12 months", "2-12 months")).toBe(false);
  });
  it("matchOnPage matches per block, never stitched across blocks, and ignores page-number blocks", () => {
    const blocks = [{ text: "Go to page 8" }, { text: "6" }, { text: "To begin treatment" }];
    expect(matchOnPage("Go to page 8 6 To begin treatment", blocks)).toBe("absent");
    expect(matchOnPage("To begin treatment", blocks)).toBe("match");
    expect(matchOnPage("6", blocks)).toBe("too_short");
    expect(matchOnPage("page 6", [{ text: "page 6" }])).toBe("absent");
    expect(matchOnPage("Write a referral note.\n Arrange transportation", [{ text: "Write a referral note." }, { text: "Arrange transportation, and help" }])).toBe("absent");
  });
});

describe("textFromQuotes and isVerbatim", () => {
  it("a text is verbatim when its words are a run of one quote's words, ignoring case and punctuation", () => {
    expect(isVerbatim("REFER URGENTLY TO HEALTH FACILITY", ["REFER URGENTLY\nTO HEALTH\nFACILITY"])).toBe(true);
    expect(isVerbatim("Fast breathing", ["Fast breathing:"])).toBe(true);
    expect(isVerbatim("Does the child have a cough?", ["Cough? If yes"])).toBe(false);
    expect(isVerbatim("Give 1 tablet", ["Give 1.5 tablet"])).toBe(false);
    expect(isVerbatim("", ["x"])).toBe(false);
  });
  it("hasNegation finds not, no, never, without, cannot, unable", () => {
    for (const t of ["Is the child not able to drink?", "No danger sign", "Cough without fast breathing", "Child cannot drink", "Unable to feed", "never"]) expect(hasNegation(t), t).toBe(true);
    for (const t of ["Is the child able to drink?", "Unusually sleepy or unconscious", "Know the signs", "Note the time"]) expect(hasNegation(t), t).toBe(false);
  });
});
