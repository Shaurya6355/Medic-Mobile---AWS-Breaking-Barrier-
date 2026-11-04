import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import type { StepContext } from "../../src/engine/step.js";
import { FakeModelClient, ModelOutputError } from "../../src/model/modelClient.js";
import { createExtractStep, findBadQuotes } from "../../src/steps/extract.js";
import { ExtractionOutput } from "../../src/steps/extractionSchema.js";
import { MemoryStore } from "../../src/store/memoryStore.js";

const extractionDir = path.resolve(import.meta.dirname, "../../extraction");
const realOutput = JSON.parse(readFileSync(path.join(extractionDir, "extraction_output.json"), "utf8"));
delete realOutput._run;
const realInput = JSON.parse(readFileSync(path.join(extractionDir, "input_blocks.json"), "utf8"));
const realBlocks = new Map<string, string>(
  realInput.pages.flatMap((p: { blocks: { block_id: string; text: string }[] }) =>
    p.blocks.map((b) => [b.block_id, b.text] as const),
  ),
);
const promptPath = path.join(extractionDir, "final_prompt.txt");

const PNG = new Uint8Array([1, 2, 3]);
const tinyDoc = {
  source_id: "g",
  doc_name: "g.pdf",
  doc_sha256: "x",
  page_count: 2,
  pages: [
    { pdf_page: 3, width: 1, height: 1, image: "pages/page-03.png", blocks: [{ block_id: "p3.b1", pdf_page: 3, bbox: [0, 0, 1, 1], text: "Cough for 14 days" }] },
    { pdf_page: 5, width: 1, height: 1, image: "pages/page-05.png", blocks: [{ block_id: "p5.b1", pdf_page: 5, bbox: [0, 0, 1, 1], text: "Fast breathing" }] },
  ],
};

function emptyOutput() {
  return { nodes: [], edges: [], variables: [], danger_signs: [], thresholds: [], actions: [], followups: [], unclear_items: [] };
}

async function setup(model: FakeModelClient) {
  const artifacts = new MemoryArtifactStore();
  await artifacts.put(artifactKey("r1", "ingest", "input_blocks.json"), JSON.stringify(tinyDoc));
  await artifacts.put(artifactKey("r1", "ingest", "pages", "page-03.png"), PNG);
  await artifacts.put(artifactKey("r1", "ingest", "pages", "page-05.png"), PNG);
  const ctx: StepContext = {
    run: { runId: "r1", state: "extracting", createdAt: 0 },
    store: new MemoryStore(),
    artifacts,
    model,
    now: () => 0,
  };
  return { ctx, artifacts };
}

const usage = { inputTokens: 10, outputTokens: 5, modelId: "m1" };
const text = (a: MemoryArtifactStore, k: string) => a.get(k).then((b) => new TextDecoder().decode(b));

describe("ExtractionOutput schema", () => {
  it("accepts the real sample output (minus _run)", () => {
    const r = ExtractionOutput.safeParse(realOutput);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 5))).toBe(true);
  });

  it("rejects a missing required field", () => {
    const bad = { ...emptyOutput(), nodes: [{ id: "n1" }] };
    expect(ExtractionOutput.safeParse(bad).success).toBe(false);
  });

  it("allows unknown extra fields on items", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].extra = "x";
    expect(ExtractionOutput.safeParse(o).success).toBe(true);
  });
});

describe("findBadQuotes", () => {
  it("reports zero for the real sample", () => {
    expect(findBadQuotes(realOutput, realBlocks)).toEqual([]);
  });

  it("reports a tampered quote", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].src[0].quote = "not in the block";
    const bad = findBadQuotes(o, realBlocks);
    expect(bad).toEqual([{ block_id: o.nodes[0].src[0].block_id, quote: "not in the block" }]);
  });

  it("reports an unknown block id", () => {
    const o = structuredClone(realOutput);
    o.nodes[0].src[0].block_id = "p99.b99";
    expect(findBadQuotes(o, realBlocks).map((b) => b.block_id)).toContain("p99.b99");
  });
});

describe("extract step", () => {
  it("has name and runState", () => {
    const s = createExtractStep({ modelId: "m1", promptPath });
    expect(s.name).toBe("extract");
    expect(s.runState).toBe("extracting");
  });

  it("builds the request, stores raw and output, returns refs and usage", async () => {
    const raw = JSON.stringify(emptyOutput());
    const model = new FakeModelClient([{ raw, usage }]);
    const { ctx, artifacts } = await setup(model);
    const res = await createExtractStep({ modelId: "m1", promptPath }).run(ctx);
    expect(res.usage).toEqual(usage);
    expect(res.artifactRefs).toEqual({
      output: "runs/r1/extract/extraction_output.json",
      raw: "runs/r1/extract/raw_response.txt",
    });
    expect(await text(artifacts, res.artifactRefs.raw!)).toBe(raw);
    expect(JSON.parse(await text(artifacts, res.artifactRefs.output!))).toEqual(emptyOutput());

    const req = model.calls[0]!;
    expect(req.modelId).toBe("m1");
    expect(req.maxTokens).toBe(32000);
    expect(req.system).toBe(readFileSync(promptPath, "utf8"));
    const c = req.content;
    expect(c).toHaveLength(1 + 3 * 2 + 1);
    expect(c[0]).toEqual({ type: "text", text: "Run: r1\nSource: g   Pages: 2\nMode: new_guideline\nFor each page, in order:" });
    expect(c[1]).toEqual({ type: "text", text: "--- pdf_page 3 ---" });
    expect(c[2]).toEqual({ type: "image", format: "png", bytes: PNG });
    expect(c[3]).toEqual({ type: "text", text: "Blocks: " + JSON.stringify(tinyDoc.pages[0]!.blocks) });
    expect(c[4]).toEqual({ type: "text", text: "--- pdf_page 5 ---" });
    expect(c[7]).toEqual({ type: "text", text: "Return one JSON object for the whole document." });
  });

  it("honors maxTokens option", async () => {
    const model = new FakeModelClient([{ raw: JSON.stringify(emptyOutput()) }]);
    const { ctx } = await setup(model);
    await createExtractStep({ modelId: "m1", promptPath, maxTokens: 123 }).run(ctx);
    expect(model.calls[0]!.maxTokens).toBe(123);
  });

  it("fails non-transient on bad quotes, keeps raw, does not store output", async () => {
    const o = emptyOutput() as Record<string, unknown[]>;
    o.unclear_items = Array.from({ length: 12 }, (_, i) => ({
      id: `u${i}`, block_id: "p3.b1", quote: "x".repeat(200), what_is_unclear: "w", related_ids: [],
    }));
    const raw = JSON.stringify(o);
    const model = new FakeModelClient([{ raw, usage }]);
    const { ctx, artifacts } = await setup(model);
    const err = await createExtractStep({ modelId: "m1", promptPath }).run(ctx).catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toContain("12");
    expect(err.message.match(/p3\.b1: /g)).toHaveLength(10);
    expect(err.message).toContain("x".repeat(80));
    expect(err.message).not.toContain("x".repeat(81));
    expect(await text(artifacts, artifactKey("r1", "extract", "raw_response.txt"))).toBe(raw);
    expect(await artifacts.exists(artifactKey("r1", "extract", "extraction_output.json"))).toBe(false);
  });

  it("propagates ModelOutputError for invalid JSON", async () => {
    const model = new FakeModelClient([{ raw: "not json" }]);
    const { ctx } = await setup(model);
    await expect(createExtractStep({ modelId: "m1", promptPath }).run(ctx)).rejects.toBeInstanceOf(ModelOutputError);
  });
});
