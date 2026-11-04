import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { OrchestratorPort } from "../../src/api/server.js";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { routes } from "../../src/contract/routes.js";
import { acceptAnyObjectValidator } from "../../src/steps/logicModelValidator.js";
import type { LogicModelValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import type { Run } from "../../src/domain/types.js";

function setup(opts: { validator?: LogicModelValidator; onVersionSaved?: (r: string, n: number) => Promise<void> } = {}) {
  const store = new MemoryStore();
  const artifacts = new MemoryArtifactStore();
  let t = 1000;
  const orchestrator: OrchestratorPort = {
    createRun: vi.fn(async (pages: number[] | undefined) => {
      const run: Run = { runId: `run-${t}`, state: "created", createdAt: t++ };
      if (pages) run.pages = pages;
      await store.createRun(run);
      return run;
    }),
    resume: vi.fn(async () => {}),
  };
  const onVersionSaved = vi.fn(opts.onVersionSaved ?? (async () => {}));
  const server = buildServer({
    orchestrator,
    store,
    artifacts,
    validator: opts.validator ?? acceptAnyObjectValidator,
    presign: async (key) => `https://upload.test/${key}`,
    onVersionSaved,
    maxPages: 50,
    now: () => 5000,
  });
  return { server, store, artifacts, orchestrator, onVersionSaved };
}

async function seedRun(store: MemoryStore, artifacts: MemoryArtifactStore, withV1 = true, state: Run["state"] = "in_review") {
  await store.createRun({ runId: "r1", state, createdAt: 1 });
  if (withV1) {
    const key = artifactKey("r1", "versions", "v1.json");
    await artifacts.put(key, JSON.stringify({ a: 1 }));
    await store.addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 2, artifactKey: key });
  }
}

describe("POST runs", () => {
  it("creates a run and returns an upload url", async () => {
    const { server, store } = setup();
    const res = await server.inject({ method: "POST", url: routes.runs(), payload: { pages: [1, 2], filename: "g.pdf" } });
    expect(res.statusCode).toBe(201);
    const { runId, uploadUrl } = res.json();
    expect(uploadUrl).toBe(`https://upload.test/runs/${runId}/input/guideline.pdf`);
    expect((await store.getRun(runId))?.state).toBe("created");
  });

  it.each([[[0]], [[1, 1]], [[51]], [[]]])("rejects pages %j and creates no run", async (pages) => {
    const { server, store, orchestrator } = setup();
    const res = await server.inject({ method: "POST", url: routes.runs(), payload: { pages, filename: "g.pdf" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(orchestrator.createRun).not.toHaveBeenCalled();
    expect(await store.listRuns()).toEqual([]);
  });

  it("omitting pages still creates a run", async () => {
    const { server } = setup();
    const res = await server.inject({ method: "POST", url: routes.runs(), payload: { filename: "g.pdf" } });
    expect(res.statusCode).toBe(201);
  });

  it("empty pages message says to omit pages and carries issues", async () => {
    const { server } = setup();
    const res = await server.inject({ method: "POST", url: routes.runs(), payload: { pages: [], filename: "g.pdf" } });
    expect(res.json().issues.join(" ")).toContain("omit pages");
  });

  it("returns 413 above the body limit", async () => {
    const { server } = setup();
    const res = await server.inject({
      method: "POST",
      url: routes.runs(),
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ filename: "x".repeat(5 * 1024 * 1024 + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "payload_too_large" });
  });

  it("returns 415 for an unsupported content type", async () => {
    const { server } = setup();
    const res = await server.inject({
      method: "POST",
      url: routes.runs(),
      headers: { "content-type": "application/xml" },
      payload: "hello",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "unsupported_media_type" });
  });

  it("rejects malformed JSON with 400", async () => {
    const { server } = setup();
    const res = await server.inject({
      method: "POST",
      url: routes.runs(),
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET runs", () => {
  it("lists newest first", async () => {
    const { server, store } = setup();
    await store.createRun({ runId: "a", state: "created", createdAt: 1 });
    await store.createRun({ runId: "b", state: "created", createdAt: 2 });
    const res = await server.inject({ method: "GET", url: routes.runs() });
    expect(res.json().map((r: Run) => r.runId)).toEqual(["b", "a"]);
  });

  it("returns state, steps and totals", async () => {
    const { server, store } = setup();
    await store.createRun({ runId: "r", state: "extracting", createdAt: 1 });
    const base = { runId: "r", status: "succeeded" as const, startedAt: 1, artifactRefs: {} };
    await store.appendStep({ ...base, step: "ingest", attempt: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.5, latencyMs: 100 });
    await store.appendStep({ ...base, step: "extract", attempt: 1, inputTokens: 20, outputTokens: 7, latencyMs: 50 });
    const res = await server.inject({ method: "GET", url: routes.run("r") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.state).toBe("extracting");
    expect(body.steps).toHaveLength(2);
    expect(body.totals).toEqual({ inputTokens: 30, outputTokens: 12, costUsd: 0.5, latencyMs: 150 });
  });

  it("totals costUsd as null when none defined", async () => {
    const { server, store } = setup();
    await store.createRun({ runId: "r", state: "created", createdAt: 1 });
    const res = await server.inject({ method: "GET", url: routes.run("r") });
    expect(res.json().totals.costUsd).toBeNull();
  });

  it("returns 404 for unknown run", async () => {
    const { server } = setup();
    expect((await server.inject({ method: "GET", url: routes.run("nope") })).statusCode).toBe(404);
  });
});

describe("versions", () => {
  it("lists versions and reads a version body", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const list = await server.inject({ method: "GET", url: routes.versions("r1") });
    expect(list.json()).toHaveLength(1);
    const one = await server.inject({ method: "GET", url: routes.version("r1", 1) });
    expect(one.json().body).toEqual({ a: 1 });
  });

  it("404 for unknown run or version, 400 for non-integer n", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    expect((await server.inject({ method: "GET", url: routes.versions("zz") })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: routes.version("r1", 9) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: `${routes.versions("r1")}/abc` })).statusCode).toBe(400);
  });

  it("save with wrong parentVersion is 409", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 0, body: {}, author: "u" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "conflict" });
  });

  it("save on a run with no versions is 409 no_base_version; unknown run 404", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts, false);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 0, body: {}, author: "u" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_base_version");
    const un = await server.inject({ method: "POST", url: routes.versions("zz"), payload: { parentVersion: 0, body: {}, author: "u" } });
    expect(un.statusCode).toBe(404);
  });

  it("valid save returns 201 {n:2}, stores artifact, calls onVersionSaved", async () => {
    const { server, store, artifacts, onVersionSaved } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, body: { x: 2 }, author: "u" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ n: 2 });
    expect(onVersionSaved).toHaveBeenCalledWith("r1", 2);
    const got = await server.inject({ method: "GET", url: routes.version("r1", 2) });
    expect(got.json().body).toEqual({ x: 2 });
    expect(got.json().version.parent).toBe(1);
  });

  it("validator failure is 422 with issues and creates no version", async () => {
    const { server, store, artifacts, onVersionSaved } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, body: [1], author: "u" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_logic_model");
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(onVersionSaved).not.toHaveBeenCalled();
  });

  it("concurrent saves on the same parent: one 201, one 409, winner artifact intact", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const save = (marker: string) =>
      server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, body: { marker }, author: marker } });
    const [a, b] = await Promise.all([save("A"), save("B")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const winner = a.statusCode === 201 ? "A" : "B";
    const versions = await store.listVersions("r1");
    expect(versions).toHaveLength(2);
    const got = await server.inject({ method: "GET", url: routes.version("r1", 2) });
    expect(got.json().body).toEqual({ marker: winner });
  });

  it("onVersionSaved throwing still returns 201", async () => {
    const { server, store, artifacts } = setup({ onVersionSaved: async () => { throw new Error("boom"); } });
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, body: {}, author: "u" } });
    expect(res.statusCode).toBe(201);
    expect(await store.listVersions("r1")).toHaveLength(2);
  });
});

describe("comments", () => {
  it("posts and lists without changing version count", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const post = await server.inject({ method: "POST", url: routes.comments("r1", 1), payload: { itemRef: "o1", text: "hi", author: "u" } });
    expect(post.statusCode).toBe(201);
    const list = await server.inject({ method: "GET", url: routes.comments("r1", 1) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].text).toBe("hi");
    expect(await store.listVersions("r1")).toHaveLength(1);
  });

  it("404 for unknown version, 400 for bad body", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const p = { itemRef: "o1", text: "hi", author: "u" };
    expect((await server.inject({ method: "POST", url: routes.comments("r1", 7), payload: p })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: routes.comments("r1", 7) })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: routes.comments("r1", 1), payload: { text: "" } })).statusCode).toBe(400);
  });
});

describe("resume", () => {
  it("409 for a non-failed run, 404 for unknown", async () => {
    const { server, store, artifacts, orchestrator } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.resume("r1") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_failed");
    expect(orchestrator.resume).not.toHaveBeenCalled();
    expect((await server.inject({ method: "POST", url: routes.resume("zz") })).statusCode).toBe(404);
  });

  it("202 for a failed run and calls resume", async () => {
    const { server, store, artifacts, orchestrator } = setup();
    await seedRun(store, artifacts, true, "failed");
    const res = await server.inject({ method: "POST", url: routes.resume("r1") });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "r1" });
    expect(orchestrator.resume).toHaveBeenCalledWith("r1");
  });

  it("a rejecting resume does not break the response", async () => {
    const { server, store, artifacts, orchestrator } = setup();
    vi.mocked(orchestrator.resume).mockRejectedValueOnce(new Error("x"));
    await seedRun(store, artifacts, true, "failed");
    const res = await server.inject({ method: "POST", url: routes.resume("r1") });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });
});
