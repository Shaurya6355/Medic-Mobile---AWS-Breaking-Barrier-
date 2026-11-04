import { describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import type { StepContext } from "../../src/engine/step.js";
import { createFillLogicStep } from "../../src/steps/fillLogic.js";
import { acceptAnyObjectValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { FakeModelClient } from "../../src/model/modelClient.js";

const extraction = { nodes: [], unclear_items: [{ id: "u1", note: "dose?" }] };
const outKey = artifactKey("r1", "extract", "extraction_output.json");
const v1Key = artifactKey("r1", "versions", "v1.json");
const step = createFillLogicStep({ validator: acceptAnyObjectValidator });

async function setup(withExtraction = true) {
  const artifacts = new MemoryArtifactStore();
  if (withExtraction) await artifacts.put(outKey, JSON.stringify(extraction));
  const store = new MemoryStore();
  const ctx: StepContext = {
    run: { runId: "r1", state: "filling_logic", createdAt: 0 },
    store,
    artifacts,
    model: new FakeModelClient([]),
    now: () => 5,
  };
  return { ctx, store, artifacts };
}
const text = (a: MemoryArtifactStore, k: string) => a.get(k).then((b) => new TextDecoder().decode(b));

describe("fill_logic step", () => {
  it("has the expected name and state", () => {
    expect(step.name).toBe("fill_logic");
    expect(step.runState).toBe("filling_logic");
  });

  it("creates exactly one version 1 with the placeholder body", async () => {
    const { ctx, store, artifacts } = await setup();
    const res = await step.run(ctx);
    const versions = await store.listVersions("r1");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ n: 1, parent: null, author: "ai", createdAt: 5, artifactKey: v1Key });
    expect(res.artifactRefs).toEqual({ version: v1Key });
    expect(res.usage).toBeUndefined();
    const body = JSON.parse(await text(artifacts, v1Key));
    expect(body.placeholder).toBe(true);
    expect(body.extraction).toEqual(extraction);
    expect(body.unclear).toEqual(extraction.unclear_items);
  });

  it("is idempotent when run twice", async () => {
    const { ctx, store } = await setup();
    await step.run(ctx);
    const res = await step.run(ctx);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(res.artifactRefs).toEqual({ version: v1Key });
  });

  it("succeeds without touching a pre-existing version 1", async () => {
    const { ctx, store, artifacts } = await setup();
    await artifacts.put(v1Key, "user edited");
    await store.addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: v1Key });
    await store.addVersion({ runId: "r1", n: 2, parent: 1, author: "user", createdAt: 2, artifactKey: "k2" });
    const res = await step.run(ctx);
    expect(await store.listVersions("r1")).toHaveLength(2);
    expect(await text(artifacts, v1Key)).toBe("user edited");
    expect(res.artifactRefs).toEqual({ version: v1Key });
  });

  it("two concurrent executions end with one version and both succeed", async () => {
    const { ctx, store } = await setup();
    const [a, b] = await Promise.all([step.run(ctx), step.run(ctx)]);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(a.artifactRefs).toEqual({ version: v1Key });
    expect(b.artifactRefs).toEqual({ version: v1Key });
  });

  it("fails when the validator rejects, writing nothing", async () => {
    const { ctx, store, artifacts } = await setup();
    const bad = createFillLogicStep({ validator: { validate: () => ({ ok: false, issues: ["a", "b"] }) } });
    await expect(bad.run(ctx)).rejects.toThrow(/a; b/);
    expect(await store.listVersions("r1")).toHaveLength(0);
    expect(await artifacts.exists(v1Key)).toBe(false);
  });

  it("fails clearly when the extraction artifact is missing", async () => {
    const { ctx } = await setup(false);
    await expect(step.run(ctx)).rejects.toThrow(/Extraction output not found/);
  });

  it("fails clearly when the extraction artifact is not JSON", async () => {
    const { ctx, artifacts } = await setup(false);
    await artifacts.put(outKey, "not json");
    await expect(step.run(ctx)).rejects.toThrow(/not valid JSON/);
  });
});

describe("acceptAnyObjectValidator", () => {
  it("accepts plain objects and rejects others", () => {
    expect(acceptAnyObjectValidator.validate({})).toEqual({ ok: true });
    for (const v of [null, [], "s", 3, undefined]) {
      const r = acceptAnyObjectValidator.validate(v);
      expect(r.ok).toBe(false);
    }
  });
});
