import { describe, expect, it, vi } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { routes } from "../../src/contract/routes.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { draftV1, officerFixed, seed, shaOf, testInputs } from "../signoff/helpers.js";

const orchestrator: OrchestratorPort = {
  createRun: vi.fn(),
  resume: vi.fn(async () => {}),
  prepareResume: vi.fn(async () => {}),
  onUploaded: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  activeCount: () => 0,
  lastStatusChange: () => undefined,
};

const j = (v: unknown) => ({ raw: JSON.stringify(v), usage: { inputTokens: 1000, outputTokens: 1000, modelId: "m" } });

async function setup(responses: ReturnType<typeof j>[] = [], chatOver: Partial<{ ratePerMin: number; maxCostUsd: number; maxTokens: number; prices: Record<string, { inPerMTok: number; outPerMTok: number }> }> = {}) {
  const s = await seed("awaiting_officer", [draftV1(), officerFixed()]);
  const signoff = new Signoff({ store: s.store, artifacts: s.artifacts, now: () => s.clock.ms++, inputs: async () => testInputs() });
  const model = new FakeModelClient(responses);
  const server = buildServer({
    orchestrator,
    store: s.store,
    artifacts: s.artifacts,
    validator: parseModelValidator,
    presign: async (k) => k,
    onVersionSaved: (runId, n) => signoff.onVersionSaved(runId, n),
    signoff,
    maxPages: 50,
    now: () => 1_700_000_000_000,
    chat: { model, modelId: "m", prices: {}, maxCostUsd: 1, ratePerMin: 10, ...chatOver },
  });
  return { ...s, server, model };
}

const who = { userId: "dr.amy", role: "clinician" };
const m2 = officerFixed();
const q = m2.questions[0]!;
const rule = m2.rules.find((r) => r.when !== "otherwise")!;
const edit = { op: "setQuestionLabel", questionId: q.id, text: "Changed label?" };

describe("clinician routes", () => {
  it("404 on an unknown run for every route", async () => {
    const { server } = await setup();
    const calls: [string, string, object?][] = [
      ["GET", routes.activity("nope")],
      ["POST", routes.chat("nope"), { ...who, messages: [{ from: "user", text: "hi" }] }],
      ["GET", routes.flow("nope", 1)],
      ["POST", routes.editsPreview("nope", 1), { ...who, edits: [edit] }],
      ["POST", routes.edits("nope", 1), { ...who, edits: [edit], modelSha: "a".repeat(64) }],
      ["GET", routes.diff("nope", 1, 2)],
      ["GET", routes.change("nope", 1)],
      ["POST", routes.restore("nope", 1), who],
    ];
    for (const [method, url, payload] of calls) {
      const res = await server.inject({ method: method as "GET", url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("activity returns lines and honours the cursor", async () => {
    const { server, store } = await setup();
    await store.appendAudit("r1", { at: 5, type: "step_started", detail: { step: "ingest" } });
    await store.appendAudit("r1", { at: 6, type: "step_succeeded", detail: { step: "ingest" } });
    const all = (await server.inject({ method: "GET", url: routes.activity("r1") })).json();
    expect(all.runState).toBe("awaiting_officer");
    const texts = all.items.map((i: { text: string }) => i.text);
    expect(texts).toContain("Started reading the guideline.");
    const next = (await server.inject({ method: "GET", url: routes.activity("r1", all.cursor - 1) })).json();
    expect(next.items).toHaveLength(1);
    expect((await server.inject({ method: "GET", url: "/runs/r1/activity?after=x" })).statusCode).toBe(400);
  });

  it("chat answers, logs the turn and stores an audit pointer", async () => {
    const { server, artifacts, store } = await setup([j({ reply: "Waiting for the officer.", citations: [{ kind: "version", ref: "2" }] })]);
    const res = await server.inject({ method: "POST", url: routes.chat("r1"), payload: { ...who, messages: [{ from: "user", text: "what now?" }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toContain("Waiting");
    const key = "runs/r1/chat/2023-11-14.jsonl";
    const log = new TextDecoder().decode(await artifacts.get(key));
    expect(JSON.parse(log.trim()).question).toBe("what now?");
    const audit = (await store.listAudit("r1")).find((e) => e.type === "chat_turn");
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain("what now?");
  });

  describe("keeping open questions from the chat", () => {
    const open = m2.open_questions.filter((x) => x.route_to === "clinician" && x.status === "open");
    const ctx = (over: object = {}) => ({
      version: 2,
      openQuestions: m2.open_questions.map((x) => ({ id: "F-" + x.id, title: x.question.slice(0, 80), answered: x.status !== "open" })),
      findings: [],
      ...over,
    });
    const ask = (server: Awaited<ReturnType<typeof setup>>["server"], context: object) =>
      server.inject({ method: "POST", url: routes.chat("r1"), payload: { ...who, messages: [{ from: "user", text: "keep it" }], context } });

    it("saves the keep as a new clinician version with the question resolved", async () => {
      const target = open[0]!;
      const { server, store } = await setup([j({ reply: "Keeping it.", citations: [], action: { type: "keep", ids: ["F-" + target.id] } })]);
      const res = await ask(server, ctx());
      expect(res.statusCode).toBe(200);
      expect(res.json().kept).toMatchObject({ version: 3, ids: [target.id] });
      expect(res.json().reply).toMatch(/Saved as version 3/);
      const v3 = (await store.listVersions("r1")).find((v) => v.n === 3)!;
      expect([v3.author, v3.authorRole, v3.origin]).toEqual(["dr.amy", "clinician", "chat_keep"]);
      expect(v3.signatures ?? []).toHaveLength(0);
    });

    it("keep_all resolves every open question for the clinician", async () => {
      const { server, store } = await setup([j({ reply: "Keeping all.", citations: [], action: { type: "keep_all" } })]);
      const res = await ask(server, ctx());
      expect(res.json().kept.ids.sort()).toEqual(open.map((x) => x.id).sort());
      expect((await store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2, 3]);
    });

    it("refuses with unsaved edits, or when the page is behind, and saves nothing", async () => {
      const act = { type: "keep", ids: ["F-" + open[0]!.id] };
      const a = await setup([j({ reply: "ok", citations: [], action: act })]);
      expect((await ask(a.server, ctx({ unsavedEdits: true }))).json().reply).toMatch(/not saved yet/);
      expect((await a.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
      const b = await setup([j({ reply: "ok", citations: [], action: act })]);
      const stale = await ask(b.server, ctx({ version: 1 }));
      expect(stale.json().kept).toBeUndefined();
      expect(stale.json().reply).toMatch(/newest is version 2/);
      expect((await b.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
    });
  });

  it("chat does not refuse an ordinary question that mentions instructions", async () => {
    const { server, model } = await setup([j({ reply: "See page 6.", citations: [] })]);
    const res = await server.inject({ method: "POST", url: routes.chat("r1"), payload: { ...who, messages: [{ from: "user", text: "What do the booklet instructions say about the prompt for fast breathing?" }] } });
    expect(res.json().reply).toBe("See page 6.");
    expect(model.calls).toHaveLength(1);
  });

  it("chat is strict, clinician only, rate limited and budgeted", async () => {
    const { server } = await setup([j({ reply: "ok", citations: [] }), j({ reply: "ok", citations: [] })], { ratePerMin: 1 });
    const post = (payload: object) => server.inject({ method: "POST", url: routes.chat("r1"), payload });
    const msgs = [{ from: "user", text: "hi" }];
    expect((await post({ ...who, role: "program_officer", messages: msgs })).statusCode).toBe(400);
    expect((await post({ ...who, messages: msgs, extra: 1 })).statusCode).toBe(400);
    expect((await post({ ...who, messages: [{ from: "user", text: "x".repeat(4001) }] })).statusCode).toBe(400);
    expect((await post({ ...who, messages: Array.from({ length: 21 }, () => msgs[0]) })).statusCode).toBe(400);
    expect((await post({ ...who, messages: msgs })).statusCode).toBe(200);
    expect((await post({ ...who, messages: msgs })).statusCode).toBe(429);
  });

  it("chat stops when the run's chat cost is over budget", async () => {
    const prices = { m: { inPerMTok: 1_000_000, outPerMTok: 1_000_000 } };
    const { server } = await setup([j({ reply: "ok", citations: [] })], { prices, maxCostUsd: 100 });
    const payload = { ...who, messages: [{ from: "user", text: "hi" }] };
    expect((await server.inject({ method: "POST", url: routes.chat("r1"), payload })).statusCode).toBe(200);
    const again = await server.inject({ method: "POST", url: routes.chat("r1"), payload });
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe("chat_budget_exceeded");
  });

  it("chat fails closed: with no prices a per-run token cap applies", async () => {
    const { server } = await setup([j({ reply: "ok", citations: [] })], { maxTokens: 1500 });
    const payload = { ...who, messages: [{ from: "user", text: "hi" }] };
    expect((await server.inject({ method: "POST", url: routes.chat("r1"), payload })).statusCode).toBe(200);
    const again = await server.inject({ method: "POST", url: routes.chat("r1"), payload });
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe("chat_budget_exceeded");
  });

  it("preview returns the findings the edited model would get, and stores none", async () => {
    const { server, store } = await setup();
    const res = await server.inject({ method: "POST", url: routes.editsPreview("r1", 2), payload: { ...who, edits: [edit] } });
    expect(res.json().findings).toMatchObject({ status: expect.any(String), blocking: expect.any(Number), gates: { canClinicianSign: expect.any(Boolean) } });
    expect(Array.isArray(res.json().findings.clinician)).toBe(true);
    expect(await store.listVersions("r1")).toHaveLength(2);
  });

  it("flow lists nodes with editable fields", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: routes.flow("r1", 2) });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes.length).toBeGreaterThan(0);
    expect(res.json().modelSha).toBe(shaOf(m2));
    expect((await server.inject({ method: "GET", url: routes.flow("r1", 9) })).statusCode).toBe(404);
  });

  it("preview saves nothing; unsupported op is 422; bad body is 400", async () => {
    const { server, store } = await setup();
    const res = await server.inject({ method: "POST", url: routes.editsPreview("r1", 2), payload: { ...who, edits: [edit] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().behaviourChanges.total).toBe(0);
    expect(await store.listVersions("r1")).toHaveLength(2);
    const un = await server.inject({ method: "POST", url: routes.editsPreview("r1", 2), payload: { ...who, edits: [{ op: "addQuestion" }] } });
    expect(un.statusCode).toBe(422);
    expect(un.json().error).toBe("unsupported_edit");
    expect((await server.inject({ method: "POST", url: routes.editsPreview("r1", 2), payload: { ...who, edits: [{ ...edit, x: 1 }] } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: routes.editsPreview("r1", 2), payload: { ...who, role: "program_officer", edits: [edit] } })).statusCode).toBe(400);
  });

  it("edits save a clinician-authored tree_edit version; stale n or sha is 409; idempotent", async () => {
    const { server, store } = await setup();
    const url = routes.edits("r1", 2);
    const payload = { ...who, edits: [edit], modelSha: shaOf(m2) };
    expect((await server.inject({ method: "POST", url, payload: { ...payload, modelSha: "0".repeat(64) } })).statusCode).toBe(409);
    expect((await server.inject({ method: "POST", url: routes.edits("r1", 1), payload: { ...payload, modelSha: shaOf(draftV1()) } })).statusCode).toBe(409);
    const ok = await server.inject({ method: "POST", url, payload, headers: { "idempotency-key": "k1" } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().n).toBe(3);
    const v = await store.getVersion("r1", 3);
    expect(v).toMatchObject({ author: "dr.amy", authorRole: "clinician", origin: "tree_edit" });
    const again = await server.inject({ method: "POST", url, payload, headers: { "idempotency-key": "k1" } });
    expect(again.statusCode).toBeLessThan(300);
    expect(await store.listVersions("r1")).toHaveLength(3);
  });

  it("diff and change record", async () => {
    const { server } = await setup();
    await server.inject({ method: "POST", url: routes.edits("r1", 2), payload: { ...who, edits: [edit], modelSha: shaOf(m2) } });
    const d = await server.inject({ method: "GET", url: routes.diff("r1", 2, 3) });
    expect(d.statusCode).toBe(200);
    expect(d.json().structural.changes.some((c: { path: string }) => c.path.endsWith(".label"))).toBe(true);
    expect(d.json().behaviourChanges.total).toBe(0);
    const c = await server.inject({ method: "GET", url: routes.change("r1", 3) });
    expect(c.statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: routes.change("r1", 1) })).statusCode).toBe(404);
  });

  it("restore copies an older version into a new one", async () => {
    const { server, store, artifacts } = await setup();
    const res = await server.inject({ method: "POST", url: routes.restore("r1", 1), payload: who });
    expect((await store.getVersion("r1", res.json().n))?.origin).toBe("restore");
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().n).toBe(3);
    const v = await store.getVersion("r1", 3);
    const body = JSON.parse(new TextDecoder().decode(await artifacts.get(v!.artifactKey)));
    expect(body.meta.version).toBe(3);
    expect(body.meta.parent_version).toBe(2);
    expect(body.questions).toEqual(draftV1().questions);
    expect((await store.getVersion("r1", 1))!.artifactKey).not.toBe(v!.artifactKey);
    expect((await server.inject({ method: "POST", url: routes.restore("r1", 1), payload: { ...who, role: "program_officer" } })).statusCode).toBe(400);
  });
});
