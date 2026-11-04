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

const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{N}/u.test(c);
const isAlnum = (c: string | undefined): boolean => isLetter(c) || isDigit(c);

/**
 * The normalised text with a space or hyphen removed only where it sits between two letters (spaced-letter
 * headings such as "N O D ANGER S IGN" and hyphenation variants), and spaces next to a dash. Digits are never joined, so "1 4" never
 * reads as "14" and "2-12" never as "212". `map[i]` is the index in `n` of the i-th character kept.
 */
function squash(n: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < n.length; i++) {
    const c = n[i] as string;
    if ((c === " " || c === "-") && isLetter(n[i - 1]) && isLetter(n[i + 1])) continue;
    // Spacing around a dash ("12 months - 1 tablet") is layout; the dash itself stays.
    if (c === " " && (n[i - 1] === "-" || n[i + 1] === "-")) continue;
    text += c;
    map.push(i);
  }
  return { text, map };
}

/** Words or numbers just before a match that reverse its meaning. "un-" only with a hyphen (a glued "un" fails the boundary). */
const NEGATION_BEFORE = /(?:^|[^\p{L}\p{N}'])(?:not|no|non|never|without|cannot|can't|don't|doesn't|isn't|unable to|un-)[\s-]*$/u;

/** A quote shorter than this proves nothing: fewer than 2 words and fewer than 8 characters. */
export function quoteTooShort(quote: string): boolean {
  const q = normalizeForQuote(quote);
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length < 2 && q.length < 8;
}

/** A block that holds only a page number ("8", "page 8"), never evidence. */
export function isPageNumberBlock(text: string): boolean {
  return /^\s*(?:page\s*|p\.?\s*)?\d{1,4}\s*$/i.test(text);
}

export type QuoteMatch = "match" | "absent" | "too_short" | "negated";

function boundaryOk(b: string, s: number, e: number, q: string): boolean {
  const first = q[0];
  const last = q[q.length - 1];
  if (isAlnum(first) && isAlnum(b[s - 1])) return false;
  if (isDigit(first) && /[.,/]/.test(b[s - 1] ?? "") && isDigit(b[s - 2])) return false;
  if (isAlnum(last) && isAlnum(b[e])) return false;
  if (isDigit(last) && /[.,/]/.test(b[e] ?? "") && isDigit(b[e + 1])) return false;
  return true;
}

/**
 * Is the quote, after normalisation, in the block text? It must start and end on a word or number boundary;
 * a negation (not, no, without, un-, ...) just before it in the block makes it "negated" (the quote drops it).
 * Quotes of fewer than 2 words and 8 characters are "too_short". One block only: callers never join blocks.
 */
export function matchQuote(quote: string, blockText: string): QuoteMatch {
  const q = normalizeForQuote(quote);
  if (q === "") return "absent";
  if (quoteTooShort(quote)) return "too_short";
  const b = normalizeForQuote(blockText);
  let negated = false;
  const consider = (s: number, e: number): boolean => {
    if (!boundaryOk(b, s, e, q)) return false;
    if (NEGATION_BEFORE.test(b.slice(Math.max(0, s - 20), s)) && !NEGATION_BEFORE.test(" " + q.split(" ")[0] + " ")) {
      negated = true;
      return false;
    }
    return true;
  };
  for (let i = b.indexOf(q); i >= 0; i = b.indexOf(q, i + 1)) if (consider(i, i + q.length)) return "match";
  const sb = squash(b);
  const sq = squash(q).text;
  if (sq !== "") {
    for (let i = sb.text.indexOf(sq); i >= 0; i = sb.text.indexOf(sq, i + 1)) {
      const s = sb.map[i] as number;
      const e = (sb.map[i + sq.length - 1] as number) + 1;
      if (consider(s, e)) return "match";
    }
  }
  return negated ? "negated" : "absent";
}

/** True when matchQuote says "match". */
export function quoteMatches(quote: string, blockText: string): boolean {
  return matchQuote(quote, blockText) === "match";
}

/** The quote against each block of a page on its own (no stitching across blocks); page-number blocks are skipped. */
export function matchOnPage(quote: string, blocks: readonly { text: string }[]): QuoteMatch {
  if (normalizeForQuote(quote) !== "" && quoteTooShort(quote)) return "too_short";
  let best: QuoteMatch = "absent";
  for (const b of blocks) {
    if (isPageNumberBlock(b.text)) continue;
    const m = matchQuote(quote, b.text);
    if (m === "match") return m;
    if (m === "negated") best = m;
  }
  return best;
}

/** Words and numbers of a text, normalised; a decimal or fraction stays one token. */
export function wordTokens(s: string): string[] {
  return normalizeForQuote(s).match(/\p{N}+(?:[.,/]\p{N}+)*|\p{L}+(?:'\p{L}+)?/gu) ?? [];
}

/** The text's words, in order and unchanged, are a run of the words of one of the quotes (case and punctuation aside). */
export function isVerbatim(text: string, quotes: readonly string[]): boolean {
  const t = wordTokens(text);
  if (t.length === 0) return false;
  for (const q of quotes) {
    const w = wordTokens(q);
    outer: for (let i = 0; i + t.length <= w.length; i++) {
      for (let j = 0; j < t.length; j++) if (w[i + j] !== t[j]) continue outer;
      return true;
    }
  }
  return false;
}

const NEGATION_WORDS = new Set(["not", "no", "never", "without", "cannot", "unable", "can't", "don't", "doesn't", "isn't", "none", "nor"]);

/** The text says "not", "no", "never", "without", "cannot", "unable" (whole words). */
export function hasNegation(text: string): boolean {
  return wordTokens(text).some((w) => NEGATION_WORDS.has(w));
}

export function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Text from the guideline reading (extraction) and from the booklet is DATA. These few patterns are the obvious shape
 * of an instruction to a computer planted in it ("ignore previous instructions", "system:"); a match is reported to a
 * person, never followed. Kept small so real booklet wording never matches.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:system|assistant)\s*:/i,
  /<\s*\/?\s*(?:system|instructions?|prompt)\b/i,
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|rules|instructions|checks)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|rules|instructions|checks)\b/i,
  /\b(?:new|override|updated)\s+instructions?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bset\s+(?:the\s+)?severity\b/i,
  /\bmark\s+(?:\w+\s+){0,3}(?:as\s+)?(?:resolved|approved|signed)\b/i,
];

export function looksLikeInstruction(s: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(s));
}
