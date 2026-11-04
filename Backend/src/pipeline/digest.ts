import type { Extracted } from "./extract.ts";

export type BlockKind = "heading" | "list_item" | "table_row" | "paragraph";
export interface Block {
  id: string;
  page: number;
  kind: BlockKind;
  text: string;
  /** Numbers with a unit, e.g. "50 breaths per minute", "2 months". Candidate thresholds. */
  numbers: string[];
  /** Contains a decision or action word (if, refer, give, classify...). Candidate rule text. */
  decision: boolean;
}
export interface Digest {
  totalPages: number;
  blocks: Block[];
  stats: { blocks: number; headings: number; decisionBlocks: number; numbers: number };
}

const DECISION = /\b(if|refer|give|classify|assess|check|count|look|listen|ask|urgent(ly)?|danger|treat|advise|follow[- ]?up|return)\b/i;
const NUMBER = /\b\d+(?:\.\d+)?\s*(?:months?|years?|days?|weeks?|hours?|breaths?(?: per minute)?|\/\s?min(?:ute)?|per minute|mg|ml|kg|°C|%)/gi;
const LIST = /^\s*(?:[-*•·]|\d{1,2}[.)])\s+/;

export const normalise = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();

function kindOf(raw: string, text: string): BlockKind {
  if (LIST.test(raw)) return "list_item";
  if (/\t|\S {3,}\S/.test(raw)) return "table_row";
  const words = text.split(" ").length;
  if (words <= 12 && !/[.;:,]$/.test(text) && (/^[A-Z0-9\s\-&/()]+$/.test(text) || /^[A-Z]/.test(text))) return "heading";
  return "paragraph";
}

/** Splits a page into blocks: by line when the text has line breaks, otherwise by sentence. */
function pieces(text: string): string[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length > 1) return lines;
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(l => l.trim());
}

/**
 * Deterministic digestion: turns extracted pages into labelled blocks with page numbers,
 * so the logic model step can cite a block and code can check every quote against the source.
 */
export function digest(x: Extracted): Digest {
  const blocks: Block[] = [];
  for (const p of x.pages) {
    let i = 0;
    for (const raw of pieces(p.text)) {
      const text = normalise(raw.replace(LIST, ""));
      if (!text) continue;
      blocks.push({ id: `p${p.n}-b${++i}`, page: p.n, kind: kindOf(raw, text), text, numbers: text.match(NUMBER) ?? [], decision: DECISION.test(text) });
    }
  }
  return {
    totalPages: x.totalPages,
    blocks,
    stats: {
      blocks: blocks.length,
      headings: blocks.filter(b => b.kind === "heading").length,
      decisionBlocks: blocks.filter(b => b.decision).length,
      numbers: blocks.reduce((n, b) => n + b.numbers.length, 0),
    },
  };
}
