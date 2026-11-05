import { readFile } from "node:fs/promises";
import { artifactKey, pageImageName } from "../artifacts/artifactStore.js";
import { UsageError, type Step } from "../engine/step.js";
import { ModelOutputError, type ModelContent } from "../model/modelClient.js";
import { ExtractionOutput } from "./extractionSchema.js";

interface InputPage {
  pdf_page: number;
  image: string;
  blocks: { block_id: string; text: string }[];
}
interface InputDoc {
  source_id: string;
  page_count: number;
  pages: InputPage[];
}

/** A quote the model got almost right, and the deterministic repair applied to it (recorded, never silent). */
export interface QuoteFix {
  kind: "typography" | "block";
  from: { block_id: string; quote: string };
  to: { block_id: string; quote: string };
}

// Curly quotes and primes become their ASCII form. One UTF-16 unit for one, so an index found in the folded
// text is the same index in the original, and the booklet's own characters can be cut out of it.
const foldQuotes = (s: string): string => s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');

/** The booklet's exact text for `quote` in `text`: as is, or after folding curly quotes only; else undefined. */
function exactIn(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const i = foldQuotes(text).indexOf(foldQuotes(quote));
  return i < 0 ? undefined : text.slice(i, i + quote.length);
}

// Block ids are p<page>.b<n> (extraction/prepare_input.py).
const pageOf = (blockId: string): string | undefined => /^(p\d+)\./.exec(blockId)?.[1];

/**
 * Checks every {block_id, quote} in the model's output against the booklet blocks, and with `apply` repairs
 * the two slips seen in real runs, deterministically:
 * - typography: the words are in the cited block but a curly quote was typed straight (or the reverse);
 *   the quote becomes the booklet's exact text;
 * - block: the quote is not in the cited block but is in exactly ONE block of the same page (the model
 *   miscounted blocks); block_id moves to that block.
 * Anything else is bad: an empty quote, a quote in no block of the page, or in several (ambiguous).
 */
export function checkQuotes(
  output: unknown,
  blocks: Map<string, string>,
  opts: { apply?: boolean } = {},
): { bad: { block_id: string; quote: string }[]; fixes: QuoteFix[] } {
  const bad: { block_id: string; quote: string }[] = [];
  const fixes: QuoteFix[] = [];
  const byPage = new Map<string, string[]>();
  for (const id of blocks.keys()) {
    const p = pageOf(id);
    if (p !== undefined) byPage.set(p, [...(byPage.get(p) ?? []), id]);
  }
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o !== null && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if ("block_id" in rec && "quote" in rec) {
        const id = String(rec.block_id);
        const quote = String(rec.quote);
        // An empty quote would match any block, so it proves nothing.
        if (quote.trim() === "") {
          bad.push({ block_id: id, quote });
        } else {
          const here = exactIn(blocks.get(id) ?? "", quote);
          let fix: QuoteFix | undefined;
          if (here === undefined) {
            const page = pageOf(id);
            const hits = (page === undefined ? [] : byPage.get(page) ?? [])
              .filter((b) => b !== id)
              .flatMap((b) => {
                const t = exactIn(blocks.get(b)!, quote);
                return t === undefined ? [] : [{ b, t }];
              });
            if (hits.length === 1) fix = { kind: "block", from: { block_id: id, quote }, to: { block_id: hits[0]!.b, quote: hits[0]!.t } };
            else bad.push({ block_id: id, quote });
          } else if (here !== quote) {
            fix = { kind: "typography", from: { block_id: id, quote }, to: { block_id: id, quote: here } };
          }
          if (fix) {
            fixes.push(fix);
            if (opts.apply) {
              rec.block_id = fix.to.block_id;
              rec.quote = fix.to.quote;
            }
          }
        }
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(output);
  return { bad, fixes };
}

/** The quotes that are not exactly in their cited block (no repair). Kept for callers that only check. */
export function findBadQuotes(output: unknown, blocks: Map<string, string>): { block_id: string; quote: string }[] {
  const { bad, fixes } = checkQuotes(output, blocks);
  return [...bad, ...fixes.map((f) => f.from)];
}

const MAX_LISTED = 10;
const MAX_QUOTE = 80;

export function createExtractStep(opts: { modelId: string; promptPath: string; maxTokens?: number }): Step {
  return {
    name: "extract",
    runState: "extracting",
    async run(ctx) {
      const runId = ctx.run.runId;
      const system = await readFile(opts.promptPath, "utf8");
      const doc = JSON.parse(
        new TextDecoder().decode(await ctx.artifacts.get(artifactKey(runId, "ingest", "input_blocks.json"))),
      ) as InputDoc;

      if (doc.pages.length === 0) throw new Error("No pages to extract");

      const content: ModelContent[] = [
        {
          type: "text",
          text: `Run: ${runId}\nSource: ${doc.source_id}   Pages: ${doc.page_count}\nMode: new_guideline\nFor each page, in order:`,
        },
      ];
      for (const p of doc.pages) {
        content.push({ type: "text", text: `--- pdf_page ${p.pdf_page} ---` });
        content.push({
          type: "image",
          format: "png",
          bytes: await ctx.artifacts.get(artifactKey(runId, "ingest", "pages", pageImageName(p.pdf_page))),
        });
        content.push({ type: "text", text: "Blocks: " + JSON.stringify(p.blocks) });
      }
      content.push({ type: "text", text: "Return one JSON object for the whole document." });

      const rawKey = artifactKey(runId, "extract", "raw_response.txt");
      let result;
      try {
        result = await ctx.model.generateJson({
          modelId: opts.modelId,
          system,
          content,
          schema: ExtractionOutput,
          maxTokens: opts.maxTokens ?? 32000,
        });
      } catch (e) {
        if (e instanceof ModelOutputError) await ctx.artifacts.put(rawKey, e.raw, "text/plain");
        throw e;
      }
      await ctx.artifacts.put(rawKey, result.raw, "text/plain");

      const blocks = new Map(doc.pages.flatMap((p) => p.blocks.map((b) => [b.block_id, b.text] as const)));
      // Repairs only unambiguous slips (see checkQuotes) and records each one; everything else still fails.
      const { bad, fixes } = checkQuotes(result.value, blocks, { apply: true });
      if (bad.length > 0) {
        const listed = bad
          .slice(0, MAX_LISTED)
          .map((b) => `${b.block_id}: ${b.quote.length > MAX_QUOTE ? b.quote.slice(0, MAX_QUOTE) : b.quote}`)
          .join("; ");
        throw new UsageError(
          `Extraction has ${bad.length} quote(s) not found in their cited block: ${listed}`,
          result.usage,
        );
      }

      const outKey = artifactKey(runId, "extract", "extraction_output.json");
      await ctx.artifacts.put(outKey, JSON.stringify(result.value, null, 2), "application/json");
      const refs: Record<string, string> = { output: outKey, raw: rawKey };
      if (fixes.length > 0) {
        const fixKey = artifactKey(runId, "extract", "quote_fixes.json");
        await ctx.artifacts.put(fixKey, JSON.stringify(fixes, null, 2), "application/json");
        refs.quoteFixes = fixKey;
        refs.quoteFixCount = String(fixes.length);
      }
      return { artifactRefs: refs, usage: result.usage };
    },
  };
}
