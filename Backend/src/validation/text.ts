/**
 * Text normalisation for comparing a model's quote with a booklet block. Pure, no I/O.
 * The booklet text has line breaks mid-sentence, end-of-line hyphenation, spaced-letter headings
 * ("N O D ANGER S IGN"), dropped ligatures and mixed dash and quote characters.
 */

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

export function normalizeForQuote(s: string): string {
  let t = s.normalize("NFC");
  t = t.replace(/[­​-‍⁠﻿]/g, "");
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c);
  t = t.replace(/[‐-―−]/g, "-");
  t = t.replace(/[‘’‚‛′`´]/g, "'");
  t = t.replace(/[“”„‟″]/g, '"');
  t = t.toLowerCase();
  // Rejoin a word split by a hyphen at the end of a line.
  t = t.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, "$1$2");
  return t.replace(/\s+/g, " ").trim();
}

/** The normalised text with every space and hyphen removed, for spaced-letter text and hyphenation variants. */
function squash(n: string): string {
  return n.replace(/[\s-]/g, "");
}

/** True when the quote, after normalisation, is a substring of the block text. Empty quotes never match. */
export function quoteMatches(quote: string, blockText: string): boolean {
  const q = normalizeForQuote(quote);
  if (q === "") return false;
  const b = normalizeForQuote(blockText);
  if (b.includes(q)) return true;
  const sq = squash(q);
  return sq !== "" && squash(b).includes(sq);
}

export function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}
