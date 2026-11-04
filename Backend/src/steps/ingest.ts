import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactKey, inputPdfKey } from "../artifacts/artifactStore.js";
import type { Step } from "../engine/step.js";

export type Exec = (cmd: string, args: string[]) => Promise<void>;

const EXEC_TIMEOUT_MS = 120000;

export const defaultExec: Exec = (cmd, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error(`Command failed: ${path.basename(cmd)} (${err.message.split("\n")[0]})`));
      else resolve();
    });
  });

interface InputPage {
  pdf_page: number;
  image: string;
}
interface InputDoc {
  page_count: number;
  pages: InputPage[];
  [k: string]: unknown;
}

export function createIngestStep(opts: { pythonBin: string; scriptPath: string; exec: Exec }): Step {
  return {
    name: "ingest",
    runState: "ingesting",
    async run(ctx) {
      const runId = ctx.run.runId;
      const pdfKey = inputPdfKey(runId);
      if (!(await ctx.artifacts.exists(pdfKey))) {
        throw new Error(`Input PDF not found for run ${runId}`);
      }
      const pdf = await ctx.artifacts.get(pdfKey);

      const dir = await mkdtemp(path.join(tmpdir(), "ingest-"));
      try {
        const pdfPath = path.join(dir, "guideline.pdf");
        const outDir = path.join(dir, "out");
        await writeFile(pdfPath, pdf);
        await opts.exec(opts.pythonBin, [opts.scriptPath, pdfPath, outDir]);

        const doc = JSON.parse(await readFile(path.join(outDir, "input_blocks.json"), "utf8")) as InputDoc;

        const selected = ctx.run.pages;
        if (selected) {
          const outOfRange = selected.filter((n) => n < 1 || n > doc.page_count);
          if (outOfRange.length > 0) {
            throw new Error(
              `Selected pages out of range: ${outOfRange.join(", ")} (document has ${doc.page_count} pages)`,
            );
          }
          const keep = new Set(selected);
          doc.pages = doc.pages.filter((p) => keep.has(p.pdf_page));
          doc.page_count = doc.pages.length;
        }

        const blocksKey = artifactKey(runId, "ingest", "input_blocks.json");
        await ctx.artifacts.put(blocksKey, JSON.stringify(doc, null, 2), "application/json");
        for (const p of doc.pages) {
          const name = p.image.split("/").pop()!;
          const bytes = await readFile(path.join(outDir, "pages", name));
          await ctx.artifacts.put(artifactKey(runId, "ingest", "pages", name), bytes, "image/png");
        }
        return { artifactRefs: { blocks: blocksKey, pages: artifactKey(runId, "ingest", "pages") + "/" } };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
