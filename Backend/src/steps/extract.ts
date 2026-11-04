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

export function findBadQuotes(
  output: unknown,
  blocks: Map<string, string>,
): { block_id: string; quote: string }[] {
  const bad: { block_id: string; quote: string }[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o !== null && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if ("block_id" in rec && "quote" in rec) {
        const id = String(rec.block_id);
        const quote = String(rec.quote);
        const text = blocks.get(id) ?? "";
        // An empty quote would match any block, so it proves nothing.
        if (quote.trim() === "" || !text.includes(quote)) bad.push({ block_id: id, quote });
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(output);
  return bad;
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
      const bad = findBadQuotes(result.value, blocks);
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
      return { artifactRefs: { output: outKey, raw: rawKey }, usage: result.usage };
    },
  };
}
