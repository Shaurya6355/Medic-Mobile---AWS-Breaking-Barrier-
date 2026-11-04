import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/api/server.js";
import type { OrchestratorPort } from "../../src/api/server.js";
import { MemoryArtifactStore, artifactKey, inputPdfKey } from "../../src/artifacts/artifactStore.js";
import { NotFound } from "../../src/artifacts/artifactStore.js";
import { routes } from "../../src/contract/routes.js";
import { acceptAnyObjectValidator } from "../../src/steps/logicModelValidator.js";
import type { LogicModelValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import type { Run } from "../../src/domain/types.js";
import { Conflict } from "../../src/store/store.js";
function setupBase(opts: { validator?: LogicModelValidator; onVersionSaved?: (r: string, n: number) => Promise<void>; clock?: { ms: number }; maxInvocationResponseBytes?: number; runMode?: "container" | "agentcore" | "lambda"; eventsConcurrency?: number; backgroundDeadlineMs?: number; eventsDeadlineMs?: number; statusChangedAtMs?: number } = {}) {
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
    prepareResume: vi.fn(async () => {}),
    onUploaded: vi.fn(async () => {}),
    resumeAll: vi.fn(async () => {}),
    activeCount: vi.fn(() => 0),
    lastStatusChange: vi.fn(() => opts.statusChangedAtMs),
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
    ...(opts.runMode ? { runMode: opts.runMode } : {}),
    ...(opts.eventsConcurrency ? { eventsConcurrency: opts.eventsConcurrency } : {}),
    ...(opts.eventsDeadlineMs ? { eventsDeadlineMs: opts.eventsDeadlineMs } : {}),
    ...(opts.backgroundDeadlineMs ? { backgroundDeadlineMs: opts.backgroundDeadlineMs } : {}),
    now: () => opts.clock?.ms ?? 5000,
    ...(opts.maxInvocationResponseBytes ? { maxInvocationResponseBytes: opts.maxInvocationResponseBytes } : {}),
  });
  return { server, store, artifacts, orchestrator, onVersionSaved };
}

const setup = setupBase;

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

describe("length limits on user strings", () => {
  it("400 and no run for a filename over 255 characters; 255 is accepted", async () => {
    const { server, store, orchestrator } = setup();
    const bad = await server.inject({ method: "POST", url: routes.runs(), payload: { filename: "f".repeat(256) } });
    expect(bad.statusCode).toBe(400);
    expect(orchestrator.createRun).not.toHaveBeenCalled();
    expect(await store.listRuns()).toEqual([]);
    const ok = await server.inject({ method: "POST", url: routes.runs(), payload: { filename: "f".repeat(255) } });
    expect(ok.statusCode).toBe(201);
  });

  it.each([
    ["text", { itemRef: "o1", text: "t".repeat(10001), author: "u" }],
    ["author", { itemRef: "o1", text: "hi", author: "a".repeat(201) }],
    ["itemRef", { itemRef: "i".repeat(501), text: "hi", author: "u" }],
  ])("400 and no comment for a comment %s over its limit", async (_n, payload) => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({ method: "POST", url: routes.comments("r1", 1), payload });
    expect(res.statusCode).toBe(400);
    expect(await store.listComments("r1", 1)).toEqual([]);
  });

  it("accepts comment fields at their limits", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const payload = { itemRef: "i".repeat(500), text: "t".repeat(10000), author: "a".repeat(200) };
    const res = await server.inject({ method: "POST", url: routes.comments("r1", 1), payload });
    expect(res.statusCode).toBe(201);
  });

  it("400 and no version for a save author over 200 characters", async () => {
    const { server, store, artifacts, onVersionSaved } = setup();
    await seedRun(store, artifacts);
    const res = await server.inject({
      method: "POST",
      url: routes.versions("r1"),
      payload: { parentVersion: 1, body: {}, author: "a".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(await store.listVersions("r1")).toHaveLength(1);
    expect(onVersionSaved).not.toHaveBeenCalled();
  });
});

describe("GET /ping", () => {
  it.each(["container", "agentcore", "lambda"] as const)("exists in %s mode", async (runMode) => {
    const { server } = setup({ runMode });
    expect((await server.inject({ method: "GET", url: routes.ping() })).statusCode).toBe(200);
  });
  it("reports Healthy when idle and HealthyBusy when active, with the engine's change time", async () => {
    const { server, orchestrator } = setup();
    const get = async () => (await server.inject({ method: "GET", url: routes.ping() })).json();
    expect(await get()).toEqual({ status: "Healthy" });

    vi.mocked(orchestrator.activeCount).mockReturnValue(2);
    vi.mocked(orchestrator.lastStatusChange).mockReturnValue(20_500);
    expect(await get()).toEqual({ status: "HealthyBusy", time_of_last_update: 20 });

    vi.mocked(orchestrator.activeCount).mockReturnValue(0);
    vi.mocked(orchestrator.lastStatusChange).mockReturnValue(100_999);
    expect(await get()).toEqual({ status: "Healthy", time_of_last_update: 100 });
  });
  it("does not stamp the time of the first ping", async () => {
    const { server, orchestrator } = setup({ clock: { ms: 777_000 } });
    vi.mocked(orchestrator.activeCount).mockReturnValue(1);
    const body = (await server.inject({ method: "GET", url: routes.ping() })).json();
    expect(body).toEqual({ status: "HealthyBusy" });
  });
});

describe("POST /invocations", () => {
  const setup = (o: Parameters<typeof setupBase>[0] = {}) => setupBase({ runMode: "agentcore", ...o });
  it.each(["container", "lambda"] as const)("does not exist in %s mode", async (runMode) => {
    const { server, orchestrator } = setupBase({ runMode });
    const res = await server.inject({ method: "POST", url: routes.invocations(), payload: { action: "resume_all" } });
    expect(res.statusCode).toBe(404);
    expect(orchestrator.resumeAll).not.toHaveBeenCalled();
  });
  it("does not exist by default", async () => {
    expect((await setupBase().server.inject({ method: "POST", url: routes.invocations(), payload: { action: "resume_all" } })).statusCode).toBe(404);
  });
  it("http: strips host, content-length, connection and transfer-encoding but keeps other headers", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const seen: Array<Record<string, unknown>> = [];
    server.addHook("onRequest", async (req) => {
      if (req.url.startsWith("/runs")) seen.push({ ...req.headers });
    });
    const res = await post(server, {
      action: "http",
      method: "GET",
      path: routes.run("r1"),
      headers: { Host: "evil.test", "Content-Length": "999", Connection: "x", "Transfer-Encoding": "chunked", "X-Keep": "yes" },
    });
    expect(res.json().statusCode).toBe(200);
    expect(seen[0]?.["x-keep"]).toBe("yes");
    expect(seen[0]?.["host"]).not.toBe("evil.test");
    expect(seen[0]?.["content-length"]).toBeUndefined();
    expect(seen[0]?.["transfer-encoding"]).toBeUndefined();
  });
  it.each(["/runs/a%2Fb", "/runs//a", "//runs", "/ping?x", "/ping?x=1#y", "/runs/%2e%2e/invocations"])("http: refuses %s", async (path) => {
    const { server } = setup();
    const res = await post(server, { action: "http", method: "GET", path });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.json().statusCode).toBeUndefined();
  });
  const post = (server: ReturnType<typeof setup>["server"], payload: unknown) =>
    server.inject({ method: "POST", url: routes.invocations(), payload: payload as object });

  it.each([[{}], [{ action: "nope" }], [{ action: "uploaded", runId: "a/b" }], [{ action: "http", method: "GET", path: "runs" }]])(
    "400 for invalid %j",
    async (payload) => {
      const { server, orchestrator } = setup();
      const res = await post(server, payload);
      expect(res.statusCode).toBe(400);
      expect(orchestrator.onUploaded).not.toHaveBeenCalled();
    },
  );

  it("uploaded: 202 and runs onUploaded in the background", async () => {
    const { server, orchestrator } = setup();
    const res = await post(server, { action: "uploaded", runId: "r-1" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("r-1");
  });

  it("uploaded: a rejecting onUploaded does not break the response", async () => {
    const { server, orchestrator } = setup();
    vi.mocked(orchestrator.onUploaded).mockRejectedValueOnce(new Error("x"));
    const res = await post(server, { action: "uploaded", runId: "r-1" });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("resume_all: 202 and runs resumeAll, errors contained", async () => {
    const { server, orchestrator } = setup();
    vi.mocked(orchestrator.resumeAll).mockRejectedValueOnce(new Error("x"));
    const res = await post(server, { action: "resume_all" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    expect(orchestrator.resumeAll).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 5));
  });

  it("http: forwards to a contract route and returns status, content-type and body only", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const res = await post(server, { action: "http", method: "GET", path: routes.run("r1") });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.statusCode).toBe(200);
    expect(Object.keys(out.headers)).toEqual(["content-type"]);
    expect(out.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(out.body).run.runId).toBe("r1");
  });

  it("http: passes method, headers and body, and relays upstream errors", async () => {
    const { server, store, artifacts } = setup();
    await seedRun(store, artifacts);
    const ok = await post(server, {
      action: "http",
      method: "POST",
      path: routes.runs(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "g.pdf" }),
    });
    expect(ok.json().statusCode).toBe(201);
    const bad = await post(server, {
      action: "http",
      method: "POST",
      path: routes.runs(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "" }),
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().statusCode).toBe(400);
    const missing = await post(server, { action: "http", method: "GET", path: routes.run("zz") });
    expect(missing.json().statusCode).toBe(404);
  });

  it("http: allows a query string on a contract route", async () => {
    const { server } = setup();
    const res = await post(server, { action: "http", method: "GET", path: routes.runs() + "?x=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().statusCode).toBe(200);
  });

  it.each([routes.invocations(), routes.ping(), routes.ping() + "?a=1", routes.invocations() + "/"])("http: refuses %s (no recursion)", async (path) => {
    const { server } = setup();
    const res = await post(server, { action: "http", method: "POST", path });
    expect(res.statusCode).toBe(400);
  });

  it.each(["/nope", "/runs/a/b/c/d", "/runs/%2e%2e/ping", "/runs/../ping", "//ping"])("http: 404 for path outside the contract %s", async (path) => {
    const { server } = setup();
    const res = await post(server, { action: "http", method: "GET", path });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.json().statusCode).toBeUndefined();
  });

  it("http: unknown path is 404", async () => {
    const { server } = setup();
    expect((await post(server, { action: "http", method: "GET", path: "/nope" })).statusCode).toBe(404);
  });

  it("http: refuses an oversized response", async () => {
    const { server, store, artifacts } = setup({ maxInvocationResponseBytes: 200 });
    await seedRun(store, artifacts);
    await artifacts.put(artifactKey("r1", "versions", "v1.json"), JSON.stringify({ big: "x".repeat(500) }));
    const res = await post(server, { action: "http", method: "GET", path: routes.version("r1", 1) });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "response_too_large" });
  });

  it("http: rejects an oversized request body at validation", async () => {
    const { server } = setup();
    const res = await post(server, { action: "http", method: "POST", path: routes.runs(), body: "a".repeat(1024 * 1024 + 1) });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /events", () => {
  const s3Body = (...runIds: string[]) =>
    JSON.stringify({
      Records: runIds.map((id) => ({ eventName: "ObjectCreated:Put", s3: { bucket: { name: "b" }, object: { key: inputPdfKey(id) } } })),
    });
  const sqs = (...records: Array<[string, string]>) => ({ Records: records.map(([messageId, body]) => ({ messageId, body, eventSource: "aws:sqs" })) });
  const post = (server: ReturnType<typeof setup>["server"], payload: unknown) =>
    server.inject({ method: "POST", url: routes.events(), payload: payload as object });

  it.each(["container", "agentcore"] as const)("does not exist in %s mode", async (runMode) => {
    const { server, orchestrator } = setup({ runMode });
    const res = await post(server, sqs(["m1", s3Body("r1")]));
    expect(res.statusCode).toBe(404);
    expect(orchestrator.onUploaded).not.toHaveBeenCalled();
  });
  it("does not exist by default", async () => {
    expect((await post(setup().server, { source: "aws.events" })).statusCode).toBe(404);
  });

  it("awaits onUploaded for every uploaded object and reports no failures", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    let finished = 0;
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      finished++;
    });
    const res = await post(server, sqs(["m1", s3Body("r1", "r2")], ["m2", s3Body("r3")]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchItemFailures: [] });
    expect(finished).toBe(3);
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("r1");
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("r2");
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("r3");
  });

  it("returns only failed records as batchItemFailures", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("boom");
    });
    const res = await post(server, sqs(["m1", s3Body("ok")], ["m2", s3Body("ok2", "bad")], ["m3", s3Body("ok3")]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("ok3");
  });

  it("treats unparseable or irrelevant records as consumed", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    const res = await post(server, sqs(["m1", "not json"], ["m2", JSON.stringify({ Records: [] })], ["m3", s3Body("r1")]));
    expect(res.json()).toEqual({ batchItemFailures: [] });
    expect(orchestrator.onUploaded).toHaveBeenCalledTimes(1);
  });

  it("limits concurrency across records", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda", eventsConcurrency: 2 });
    let cur = 0;
    let max = 0;
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 5));
      cur--;
    });
    const res = await post(server, sqs(...["a", "b", "c", "d", "e"].map((id): [string, string] => [id, s3Body(id)])));
    expect(res.json()).toEqual({ batchItemFailures: [] });
    expect(orchestrator.onUploaded).toHaveBeenCalledTimes(5);
    expect(max).toBe(2);
  });

  it("scheduled event awaits resumeAll", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    let done = false;
    (orchestrator.resumeAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    const res = await post(server, { source: "aws.events", "detail-type": "Scheduled Event" });
    expect(res.statusCode).toBe(200);
    expect(done).toBe(true);
    expect(res.json()).toEqual({ batchItemFailures: [] });
  });

  it("scheduled event with a failing resumeAll answers 500", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    (orchestrator.resumeAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("x"));
    expect((await post(server, { source: "aws.events" })).statusCode).toBe(500);
  });

  it("an unknown run (NotFound) is consumed, not failed", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFound("Run not found: x"));
    const res = await post(server, sqs(["m1", s3Body("gone")]));
    expect(res.json()).toEqual({ batchItemFailures: [] });
  });

  it("one malformed or oversized record does not reject the batch", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    const payload = {
      Records: [
        { messageId: "m1", body: "x".repeat(1024 * 1024 + 1) },
        { messageId: "m2" },
        "junk",
        null,
        { messageId: "m3", body: s3Body("r1") },
      ],
    };
    const res = await post(server, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchItemFailures: [] });
    expect(orchestrator.onUploaded).toHaveBeenCalledTimes(1);
    expect(orchestrator.onUploaded).toHaveBeenCalledWith("r1");
  });

  it("at the overall deadline every unfinished record is returned as failed", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda", eventsDeadlineMs: 30, eventsConcurrency: 1 });
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id !== "fast") await new Promise(() => {});
    });
    const res = await post(server, sqs(["m1", s3Body("fast")], ["m2", s3Body("hang")], ["m3", s3Body("never-started")]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }] });
    expect(orchestrator.onUploaded).not.toHaveBeenCalledWith("never-started");
  });

  it.each([[{ hello: 1 }], [{ Records: [] }], [{ Records: "x" }], [{ Records: Array.from({ length: 101 }, () => 1) }], [[]]])("rejects %j with 400", async (payload) => {
    const { server, orchestrator } = setup({ runMode: "lambda" });
    const res = await post(server, payload);
    expect(res.statusCode).toBe(400);
    expect(orchestrator.onUploaded).not.toHaveBeenCalled();
    expect(orchestrator.resumeAll).not.toHaveBeenCalled();
  });
});

describe("lambda mode waits for background work", () => {
  const slow = (state: { done: boolean }) => async () => {
    await new Promise((r) => setTimeout(r, 15));
    state.done = true;
  };

  it("resume route in lambda mode only prepares the resume and answers at once", async () => {
    const { server, store, artifacts, orchestrator } = setup({ runMode: "lambda" });
    await seedRun(store, artifacts, true, "failed");
    (orchestrator.resume as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const res = await server.inject({ method: "POST", url: routes.resume("r1") });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "r1" });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(orchestrator.prepareResume).toHaveBeenCalledWith("r1");
    expect(orchestrator.resume).not.toHaveBeenCalled();
  });
  it("resume route in lambda mode answers 409 when the run is no longer failed", async () => {
    const { server, store, artifacts, orchestrator } = setup({ runMode: "lambda" });
    await seedRun(store, artifacts, true, "failed");
    (orchestrator.prepareResume as ReturnType<typeof vi.fn>).mockRejectedValue(new Conflict("raced"));
    expect((await server.inject({ method: "POST", url: routes.resume("r1") })).statusCode).toBe(409);
  });
  it("scheduled resume-all stops waiting at the deadline", async () => {
    const { server, orchestrator } = setup({ runMode: "lambda", eventsDeadlineMs: 20 });
    (orchestrator.resumeAll as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const res = await server.inject({ method: "POST", url: routes.events(), payload: { source: "aws.events" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ batchItemFailures: [] });
  });
  it("container and agentcore modes do not wait", async () => {
    const { server, orchestrator } = setupBase({ runMode: "agentcore" });
    const a = { done: false };
    (orchestrator.onUploaded as ReturnType<typeof vi.fn>).mockImplementation(slow(a));
    expect((await server.inject({ method: "POST", url: routes.invocations(), payload: { action: "uploaded", runId: "r1" } })).statusCode).toBe(202);
    expect(a.done).toBe(false);
  });
});
