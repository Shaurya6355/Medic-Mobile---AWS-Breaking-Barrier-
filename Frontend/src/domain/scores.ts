/* Quote-support scores (advisory). The backend's judge model scores how well each cited guideline quote
   supports its item, so the clinician reads the weak ones first. They are an opinion: never a check, never
   counted as blocking, never part of gate() or the approve button (Medic rule 6: a model never judges a test).
   Scores belong to the version that was scored (`base`); an item edited since then shows its score as out of date. */
import { item } from "../../../shared/pathway/index.ts";
import { nodeSig } from "./logic";
import type { ItemId, Model, QuoteScores, ScoreItem } from "./types";

/** The scorer's item path as the UI's item id. Actions and the outcome itself share the outcome's box. */
export function toItemId(path: string): ItemId | null {
  if (path === "scope") return item.scope;
  const [head, key, sub] = path.split("/");
  if (!key) return null;
  switch (head) {
    case "questions": return item.q(key);
    case "derived": return item.d(key);
    case "rules": return item.rule(key);
    case "outcomes": return sub === "follow_up" ? item.fu(key) : item.out(key);
  }
  return null;
}

export interface ItemScore {
  id: ItemId;
  /** The lowest-scoring entry for this item (an outcome and its actions share one id). */
  entry: ScoreItem;
  /** Every entry that maps to this item, lowest score first. */
  entries: ScoreItem[];
  flagged: boolean;
  /** The item changed since it was scored: the score describes the earlier text. */
  stale: boolean;
}

const rank = (s: ScoreItem) => (s.score === null ? -1 : s.score);

/** One entry per item id: lowest score wins, flagged if any of its entries is flagged. */
export function scoreIndex(s: QuoteScores | null | undefined, current: Model): Map<ItemId, ItemScore> {
  const out = new Map<ItemId, ItemScore>();
  if (!s || s.status !== "scored") return out;
  for (const e of s.items) {
    const id = toItemId(e.item);
    if (!id) continue;
    const prev = out.get(id);
    const entries = (prev ? [...prev.entries, e] : [e]).sort((a, b) => rank(a) - rank(b));
    out.set(id, { id, entry: entries[0], entries, flagged: entries.some(x => x.flag), stale: false });
  }
  for (const v of out.values()) v.stale = nodeSig(current, v.id) !== nodeSig(s.base, v.id);
  return out;
}

/** Flagged items whose score still applies, lowest first: the "read these first" list. */
export function readFirst(idx: Map<ItemId, ItemScore>): ItemScore[] {
  return [...idx.values()].filter(v => v.flagged && !v.stale).sort((a, b) => rank(a.entry) - rank(b.entry));
}

export const fmtScore = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : x.toFixed(2));

/** Badge for the flow and the rule table: [css class, label]. Null when the item has nothing to show. */
export function scoreBadge(v: ItemScore | undefined): [string, string] | null {
  if (!v || !v.flagged) return null;
  return v.stale ? ["qs old", "Quote " + fmtScore(v.entry.score)] : ["qs", "Quote " + fmtScore(v.entry.score)];
}

/** Sample mode only (no backend): a few made-up scores on the bundled sample draft, labelled as samples. */
export function sampleScores(m: Model): QuoteScores {
  const all: ScoreItem[] = [
    { item: "rules/R5", kind: "rule", score: 0.48, flag: true, why: "score 0.48 is below 0.7", agreement: 1, lowest_reason: "Sample: the quote supports the breathing thresholds but says nothing about treating at home.", pages: [8], quotes: [] },
    { item: "derived/fast_breathing", kind: "derived", score: 0.61, flag: true, why: "score 0.61 is below 0.7; the judge disagreed with itself (1 of 3 passed)", agreement: 0.667, lowest_reason: "Sample: the quote does not say which threshold a child of exactly 12 months gets.", pages: [8], quotes: [] },
    { item: "questions/unusually_sleepy", kind: "question", score: 0.66, flag: true, why: "score 0.66 is below 0.7", agreement: 1, lowest_reason: "Sample: the quote names the sign but not the wording of the question.", pages: [], quotes: [] },
    { item: "questions/cough", kind: "question", score: 0.93, flag: false, why: null, agreement: 1, pages: [], quotes: [] },
    { item: "rules/R4", kind: "rule", score: 0.9, flag: false, why: null, agreement: 1, pages: [], quotes: [] },
  ];
  // Keep only items the sample draft has, so the sample never points at nothing.
  const items = all.filter(e => { const id = toItemId(e.item); return id !== null && nodeSig(m, id) !== "null" && nodeSig(m, id) !== ""; });
  return {
    status: "scored", n: 1, modelSha: "sample", sample: true, base: m, items,
    notice: "Sample scores: there is no backend in this mode. Advisory only: a model's opinion of whether each quote supports its item. It is not a check, never blocks a signature, and a high score does not mean the item is clinically right.",
    summary: { scored: items.length, flagged: items.filter(i => i.flag).length, not_scored: 0 },
  };
}
