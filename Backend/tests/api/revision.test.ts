import { describe, expect, it, vi } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { routes } from "../../src/contract/routes.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { InProcessDispatcher, LambdaAsyncDispatcher } from "../../src/revision/dispatch.js";
import { RevisionService } from "../../src/revision/service.js";
import { revisionKey } from "../../src/revision/types.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { draftV1, seed, testInputs } from "../signoff/helpers.js";
import { FakeEngine, INSTRUCTION_RAW, PROPOSAL_RAW } from "../revision/service/fakeEngine.js";

const orchestrator: OrchestratorPort = {
  createRun: vi.fn(),
  resume: vi.fn(async () => {}),
  prepareResume: vi.fn(async () => {}),
  onUploaded: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  activeCount: () => 0,
  lastStatusChange: () => undefined,
};
const u = { inputTokens: 1, outputTokens: 1, modelId: "m1" };

async function setup(responses: ({ raw: string; usage: typeof u } | Error)[] = [{ raw: INSTRUCTION_RAW, usage: u }, { raw: PROPOSAL_RAW, usage: u }], runMode?: "lambda") {
  const s = await seed("awaiting_officer", [draftV1()]);
  const signoff = new Signoff({ store: s.store, artifacts: s.artifacts, now: () => s.clock.ms++, inputs: async () => testInputs() });
  const onVersionSaved = (r: string, n: number) => signoff.onVersionSaved(r, n);
  const inProcess = new InProcessDispatcher((j) => revisions.runApply(j.runId, j.revisionId));
  const revisions: RevisionService = new RevisionService({
    dispatcher: inProcess,
    store: s.store,
    artifacts: s.artifacts,
    model: new FakeModelClient(responses),
    engine: new FakeEngine(),
    modelId: "m1",
    prompts: { fill: "F", instruction: "I", revise: "R" },
    now: () => s.clock.ms++,
    onVersionSaved,
  });
  const server = buildServer({ orchestrator, store: s.store, artifacts: s.artifacts, validator: parseModelValidator, presign: async (k) => k, onVersionSaved, signoff, revisions, maxPages: 50, now: () => s.clock.ms++, ...(runMode ? { runMode } : {}) });
  return { ...s, server, inProcess, revisions };
}
type T = Awaited<ReturnType<typeof setup>>;
const comment = (t: T) => t.server.inject({ method: "POST", url: routes.comments("r1", 1), payload: { itemRef: "rules.R1", text: "Please check this threshold", author: "alice" } });
const create = (t: T, payload: object = { role: "program_officer", userId: "Alice" }) => t.server.inject({ method: "POST", url: routes.revisions("r1", 1), payload });

describe("revision routes", () => {
  it("are exposed to the HTTP API and the agentcore proxy", () => {
    expect(routes.revisions("r1", 2)).toBe("/runs/r1/versions/2/revisions");
    expect(routes.revision("r1", "x")).toBe("/runs/r1/revisions/x");
    expect(routes.revisionConfirm("r1", "x")).toBe("/runs/r1/revisions/x/confirm");
    expect(routes.proxiable).toEqual(expect.arrayContaining([routes.pattern.revisions, routes.pattern.revision, routes.pattern.revisionConfirm]));
  });
});

describe("revision HTTP flow", () => {
  it("create 201, list, get, confirm 202 (applying), poll to applied, and a new version with checks run", async () => {
    const t = await setup();
    await comment(t);
    const res = await create(t);
    expect(res.statusCode).toBe(201);
    const rev = res.json();
    expect(rev).toMatchObject({ status: "instruction_ready", fromVersion: 1, requestedBy: { userId: "alice", role: "program_officer" } });

    const list = await t.server.inject({ method: "GET", url: routes.revisions("r1", 1) });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((r: { id: string }) => r.id)).toEqual([rev.id]);
    const one = await t.server.inject({ method: "GET", url: routes.revision("r1", rev.id) });
    expect(one.json().id).toBe(rev.id);

    const conf = await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", rev.id), payload: { role: "clinician", userId: "bob", instruction: "An edited instruction for the AI" } });
    expect(conf.statusCode).toBe(202);
    expect(conf.json()).toMatchObject({ status: "applying", confirmedInstruction: "An edited instruction for the AI" });
    await t.inProcess.drain();
    const polled = await t.server.inject({ method: "GET", url: routes.revision("r1", rev.id) });
    expect(polled.json()).toMatchObject({ status: "applied", toVersion: 2 });
    const v2 = await t.server.inject({ method: "GET", url: routes.version("r1", 2) });
    expect(v2.json().version).toMatchObject({ n: 2, parent: 1, author: "ai" });
    const status = await t.server.inject({ method: "GET", url: routes.status("r1", 2) });
    expect(status.statusCode).toBe(200);
    expect((await t.store.getRun("r1"))!.state).toBe("awaiting_officer");

    const again = await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", rev.id), payload: { role: "clinician", userId: "bob" } });
    expect(again.statusCode).toBe(409);
  });

  it("422 no_comments, 400 bad body, 404 unknown, 409 not latest", async () => {
    const t = await setup();
    expect((await create(t)).statusCode).toBe(422);
    expect((await create(t)).json().error).toBe("no_comments");
    expect((await create(t, { role: "x", userId: "a" })).statusCode).toBe(400);
    expect((await create(t, { role: "clinician", userId: "a", extra: 1 })).statusCode).toBe(400);
    expect((await t.server.inject({ method: "GET", url: routes.revision("r1", "missing") })).statusCode).toBe(404);
    expect((await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", "missing"), payload: { role: "clinician", userId: "bob" } })).statusCode).toBe(404);
    expect((await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", "missing"), payload: { role: "clinician", userId: "bob", instruction: "short" } })).statusCode).toBe(400);
    await comment(t);
    await t.store.addVersion({ runId: "r1", n: 2, parent: 1, author: "x", createdAt: 7, artifactKey: (await t.store.getVersion("r1", 1))!.artifactKey });
    const stale = await create(t);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("not_latest");
  });

  it("revision routes are absent when the revision service is not wired", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const server = buildServer({ orchestrator, store: s.store, artifacts: s.artifacts, validator: parseModelValidator, presign: async (k) => k, onVersionSaved: async () => {}, maxPages: 50 });
    expect((await server.inject({ method: "GET", url: routes.revisions("r1", 1) })).statusCode).toBe(404);
  });
});

describe("revision hardening", () => {
  it("GET /runs/:id sums revision usage from the audit and survives a corrupt revision artifact", async () => {
    const t = await setup();
    await comment(t);
    const rev = (await create(t)).json();
    await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", rev.id), payload: { role: "clinician", userId: "bob" } });
    await t.inProcess.drain();
    await t.artifacts.put(revisionKey("r1", rev.id), "garbage{", "application/json");
    const res = await t.server.inject({ method: "GET", url: routes.run("r1") });
    expect(res.statusCode).toBe(200);
    expect(res.json().byProcess.revision).toMatchObject({ inputTokens: 2, outputTokens: 2 });
    expect(res.json().byVersion["1"].inputTokens).toBeGreaterThanOrEqual(2);
    const list = await t.server.inject({ method: "GET", url: routes.revisions("r1", 1) });
    expect(list.json()).toEqual([]);
  });

  it("GET /runs/:id does not read revision artifacts", async () => {
    const t = await setup();
    await comment(t);
    await create(t);
    const spy = vi.spyOn(t.artifacts, "get");
    await t.server.inject({ method: "GET", url: routes.run("r1") });
    expect(spy.mock.calls.filter(([k]) => String(k).includes("/revisions/"))).toEqual([]);
  });

  it("step 1 model failure: 502 model_unavailable with the revision id and no raw error text", async () => {
    const t = await setup([new Error("ThrottlingException secret-host.amazonaws.com")]);
    await comment(t);
    const res = await create(t);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "model_unavailable", revisionId: expect.any(String) });
    expect(res.body).not.toContain("secret-host");
    const run = await t.server.inject({ method: "GET", url: routes.run("r1") });
    expect(run.statusCode).toBe(200);
  });

  it("dispatch failure answers 502 dispatch_failed", async () => {
    const t = await setup();
    await comment(t);
    const rev = (await create(t)).json();
    (t.inProcess as { dispatch: unknown }).dispatch = async () => { throw new Error("boom"); };
    const res = await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", rev.id), payload: { role: "clinician", userId: "bob" } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "dispatch_failed", revisionId: rev.id });
  });
});

describe("POST /events with a revision event (lambda mode)", () => {
  it("runs step 2 and answers 200; a repeat is harmless", async () => {
    const t = await setup(undefined, "lambda");
    await comment(t);
    const rev = (await create(t)).json();
    // simulate Lambda: nothing runs in this process; the self-invoke event does the work
    (t.inProcess as { dispatch: unknown }).dispatch = async () => {};
    await t.server.inject({ method: "POST", url: routes.revisionConfirm("r1", rev.id), payload: { role: "clinician", userId: "bob" } });
    expect((await t.server.inject({ method: "GET", url: routes.revision("r1", rev.id) })).json().status).toBe("applying");
    const res = await t.server.inject({ method: "POST", url: routes.events(), payload: { source: "revision", runId: "r1", revisionId: rev.id } });
    expect(res.statusCode).toBe(200);
    const again = await t.server.inject({ method: "POST", url: routes.events(), payload: { source: "revision", runId: "r1", revisionId: rev.id } });
    expect(again.statusCode).toBe(200);
    expect((await t.server.inject({ method: "GET", url: routes.revision("r1", rev.id) })).json().status).toBe("applied");
    expect((await t.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
  });

  it("an unknown revision is answered 200 (nothing to retry); a bad payload is 400", async () => {
    const t = await setup(undefined, "lambda");
    expect((await t.server.inject({ method: "POST", url: routes.events(), payload: { source: "revision", runId: "r1", revisionId: "nope" } })).statusCode).toBe(200);
    expect((await t.server.inject({ method: "POST", url: routes.events(), payload: { source: "revision", runId: "../x", revisionId: "a" } })).statusCode).toBe(400);
  });
});

describe("dispatchers", () => {
  it("InProcessDispatcher runs the job after dispatch returns, catches errors and drains", async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const d = new InProcessDispatcher(async (j) => { seen.push(j.revisionId); if (j.revisionId === "bad") throw new Error("x"); }, (_j, e) => errors.push(e));
    await d.dispatch({ runId: "r", revisionId: "a" });
    await d.dispatch({ runId: "r", revisionId: "bad" });
    expect(seen).toEqual([]);
    await d.drain();
    expect(seen).toEqual(["a", "bad"]);
    expect(errors).toHaveLength(1);
    expect(d.size()).toBe(0);
  });

  it("LambdaAsyncDispatcher invokes the function with InvocationType Event and the revision payload", async () => {
    const sent: { input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array } }[] = [];
    const d = new LambdaAsyncDispatcher({ send: async (c) => { sent.push(c as never); return { StatusCode: 202 }; } }, "my-fn");
    await d.dispatch({ runId: "r1", revisionId: "abc" });
    expect(sent[0]!.input).toMatchObject({ FunctionName: "my-fn", InvocationType: "Event" });
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.input.Payload))).toEqual({ source: "revision", runId: "r1", revisionId: "abc" });
    const bad = new LambdaAsyncDispatcher({ send: async () => ({ StatusCode: 500 }) }, "my-fn");
    await expect(bad.dispatch({ runId: "r1", revisionId: "abc" })).rejects.toThrow();
    const thrower = new LambdaAsyncDispatcher({ send: async () => { throw new Error("denied"); } }, "my-fn");
    await expect(thrower.dispatch({ runId: "r1", revisionId: "abc" })).rejects.toThrow("denied");
  });
});
