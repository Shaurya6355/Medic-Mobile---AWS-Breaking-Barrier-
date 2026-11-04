/** LLM01: flag text that looks like an instruction to the computer. Same patterns as validation/text.ts. */
import { looksLikeInstruction } from "../validation/text.js";

export { looksLikeInstruction };

export function flagInjected(passages: readonly string[]): { clean: string[]; flagged: string[] } {
  const clean: string[] = [];
  const flagged: string[] = [];
  for (const p of passages) (looksLikeInstruction(p) ? flagged : clean).push(p);
  return { clean, flagged };
}

/** Wrap untrusted text in a delimited data block; the delimiter cannot be forged from inside. */
export function asDataBlock(label: string, text: string): string {
  const safe = text.replace(/<\s*\/?\s*data\b/gi, "[data");
  return `<data label="${label.replace(/[^a-z0-9_-]/gi, "")}">\n${safe}\n</data>`;
}
