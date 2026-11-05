import { describe, expect, it, vi } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { routes } from "../../src/contract/routes.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { createHash } from "node:crypto";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { draftV1, fullyResolved, officerFixed, openFor, seed, shaOf, testInputs } from "../signoff/helpers.js";

const orchestrator: OrchestratorPort = {
  createRun: vi.fn(),
  resume: vi.fn(async () => {}),
  prepareResume: vi.fn(async () => {}),
  onUploaded: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  activeCount: () => 0,
  lastStatusChange: () => undefined,
};

async function setup(
  models = [draftV1()],
  state: Parameters<typeof seed>[0] = "awaiting_officer",
  runMode: "container" | "agentcore" = "container",
  onSaved?: (runId: string, n: number) => Promise<void>,
) {
  const s = await seed(state, models);
  const signoff = new Signoff({ store: s.store, artifacts: s.artifacts, now: () => s.clock.ms++, inputs: async () => testInputs() });
  const server = buildServer({
    orchestrator,
    store: s.store,
    artifacts: s.artifacts,
    validator: parseModelValidator,
    presign: async (k) => k,
    onVersionSaved: onSaved ?? ((runId, n) => signoff.onVersionSaved(runId, n)),
    signoff,
    maxPages: 50,
    runMode,
  });
  return { ...s, server };
}

const sign = (server: Awaited<ReturnType<typeof setup>>["server"], n: number, role: string, body: unknown) =>
  server.inject({ method: "POST", url: routes.sign("r1", n, role), payload: body as object });

describe("contract routes for sign-off", () => {
  it("builds the paths and exposes them to the HTTP API and the agentcore proxy", () => {
    expect(routes.findings("r1", 2)).toBe("/runs/r1/versions/2/findings");
    expect(routes.status("r1", 2)).toBe("/runs/r1/versions/2/status");
    expect(routes.sign("r1", 2, "clinician")).toBe("/runs/r1/versions/2/signatures/clinician");
    expect(routes.proxiable).toEqual(expect.arrayContaining([routes.pattern.findings, routes.pattern.status, routes.pattern.sign]));
  });
});

describe("GET findings", () => {
  it("returns every finding without an audience, with the modelSha and the gates", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: routes.findings("r1", 1) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.modelSha).toBe(shaOf(draftV1()));
    expect(body.audience).toBe("all");
    const open = body.findings.filter((f: { severity: string; code: string }) => f.severity === "blocking" && f.code === "OPEN_QUESTION");
    expect(open).toHaveLength(draftV1().open_questions.length);
    expect(body.gates.canOfficerSign).toBe(false);
  });

  it("filters by audience and words each finding for that role", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: `${routes.findings("r1", 1)}?audience=program_officer` });
    expect(res.statusCode).toBe(200);
    const groups = res.json().groups as { severity: string; findings: { audience: string[]; yours: boolean }[] }[];
    expect(groups.flatMap((g) => g.findings).every((f) => f.audience.includes("program_officer"))).toBe(true);
    expect(groups[0]!.severity).toBe("blocking");
    const mine = groups[0]!.findings.filter((f) => f.yours && (f as unknown as { code: string }).code === "OPEN_QUESTION");
    expect(mine).toHaveLength(openFor(draftV1(), "program_officer"));
  });

  it("400 for an audience that is not a signer role", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: `${routes.findings("r1", 1)}?audience=it` });
    expect(res.statusCode).toBe(400);
  });

  it("404 for an unknown version or run", async () => {
    const { server } = await setup();
    expect((await server.inject({ method: "GET", url: routes.findings("r1", 9) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: routes.findings("nope", 1) })).statusCode).toBe(404);
  });
});

describe("GET status", () => {
  it("shows where the version stands and what comes next", async () => {
    const { server } = await setup();
    const res = await server.inject({ method: "GET", url: routes.status("r1", 1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ n: 1, latest: 1, status: "awaiting_officer", runState: "awaiting_officer", signatures: [], latestLocked: null });
    expect(res.json().nextStep).toMatch(/before the officer agent can sign/);
  });
});

describe("POST acknowledge (clinician keeps blocking findings)", () => {
  it("accepted findings stop blocking, are recorded, and the clinician can then sign", async () => {
    const m = officerFixed();
    const sha = shaOf(m);
    const { server, signoff, store } = await setup([m], "awaiting_officer");
    await signoff.signAsAgent("r1", 1, sha);
    const blocked = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha });
    expect(blocked.statusCode).toBe(422);
    const f = (await server.inject({ method: "GET", url: `${routes.findings("r1", 1)}?audience=clinician` })).json();
    const ids = f.groups.flatMap((g: { findings: { id: string; severity: string; yours: boolean }[] }) => g.findings).filter((x: { severity: string; yours: boolean }) => x.severity === "blocking" && x.yours).map((x: { id: string }) => x.id);
    expect(ids.length).toBeGreaterThan(0);
    const short = await server.inject({ method: "POST", url: routes.acknowledge("r1", 1), payload: { role: "clinician", userId: "clinician-1", findingIds: ids, note: "ok" } });
    expect(short.statusCode).toBe(400);
    const wrong = await server.inject({ method: "POST", url: routes.acknowledge("r1", 1), payload: { role: "clinician", userId: "clinician-1", findingIds: ["0".repeat(64)], note: "Kept as correct by the clinician." } });
    expect([wrong.statusCode, wrong.json().error]).toEqual([422, "not_acceptable"]);
    const ok = await server.inject({ method: "POST", url: routes.acknowledge("r1", 1), payload: { role: "clinician", userId: "clinician-1", findingIds: ids, note: "Kept as correct by the clinician." } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().gates.canClinicianSign).toBe(true);
    expect((await store.listAudit("r1")).some((a: { type: string }) => a.type === "findings_accepted")).toBe(true);
    const signed = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha });
    expect(signed.statusCode).toBe(201);
  });
});

describe("POST sign", () => {
  it("422 while blockers for that role remain, with the blockers in plain words", async () => {
    const { server, signoff } = await setup();
    const res = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: shaOf(draftV1()) });
    expect(res.statusCode).toBe(409);
    const e = (await signoff.signAsAgent("r1", 1, shaOf(draftV1())).catch((x: unknown) => x)) as { status: number; code: string; detail: { blockers: { code: string; message: string }[] } };
    expect([e.status, e.code]).toEqual([422, "blocked"]);
    expect(e.detail.blockers.filter((b: { code: string }) => b.code === "OPEN_QUESTION")).toHaveLength(openFor(draftV1(), "program_officer"));
    expect(e.detail.blockers[0]!.message).toMatch(/\w/);
  });

  it("403 agent_only: no HTTP caller can fill the program officer signature", async () => {
    const { server, store } = await setup([fullyResolved()]);
    const res = await sign(server, 1, "program_officer", { role: "program_officer", userId: "officer-1", modelSha: shaOf(fullyResolved()) });
    expect([res.statusCode, res.json().error]).toEqual([403, "agent_only"]);
    expect((await store.getVersion("r1", 1))!.signatures ?? []).toEqual([]);
  });

  it("refuses the officer agent's reserved id in a sign, reject or save body", async () => {
    const { server } = await setup([fullyResolved()]);
    const sha = shaOf(fullyResolved());
    expect((await sign(server, 1, "clinician", { role: "clinician", userId: "Officer-Agent@System", modelSha: sha })).statusCode).toBe(400);
    const rej = await server.inject({ method: "POST", url: routes.reject("r1", 1), payload: { role: "clinician", userId: "officer-agent@system", modelSha: sha, comment: "This rule is wrong and must change." } });
    expect(rej.statusCode).toBe(400);
    const save = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "officer-agent@system", body: {} } });
    expect(save.statusCode).toBe(400);
  });

  it("403 agent_only when a save names the program officer role", async () => {
    const { server, store } = await setup([fullyResolved()]);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "o", authorRole: "program_officer", body: nextBody() } });
    expect([res.statusCode, res.json().error]).toEqual([403, "agent_only"]);
    expect(await store.listVersions("r1")).toHaveLength(1);
  });

  it("403 when the role in the body does not match the endpoint", async () => {
    const { server } = await setup([fullyResolved()]);
    const res = await sign(server, 1, "clinician", { role: "program_officer", userId: "officer-1", modelSha: shaOf(fullyResolved()) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("role_mismatch");
  });

  it("404 for an endpoint role that does not exist", async () => {
    const { server } = await setup([fullyResolved()]);
    const res = await sign(server, 1, "it", { role: "program_officer", userId: "x", modelSha: shaOf(fullyResolved()) });
    expect(res.statusCode).toBe(404);
  });

  it("400 for a body without userId or with a bad modelSha", async () => {
    const { server } = await setup([fullyResolved()]);
    expect((await sign(server, 1, "program_officer", { role: "program_officer", modelSha: shaOf(fullyResolved()) })).statusCode).toBe(400);
    expect((await sign(server, 1, "program_officer", { role: "program_officer", userId: "o", modelSha: "abc" })).statusCode).toBe(400);
  });

  it("409 for the clinician before the officer", async () => {
    const { server } = await setup([fullyResolved()]);
    const res = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: shaOf(fullyResolved()) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("officer_signature_required");
  });

  it("409 for a sha the version does not have", async () => {
    const { server, signoff } = await setup([fullyResolved()]);
    await signoff.signAsAgent("r1", 1, shaOf(fullyResolved()));
    const res = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: "0".repeat(64) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sha_mismatch");
  });

  it("agent signs, clinician 201 and locked", async () => {
    const { server, signoff } = await setup([fullyResolved()]);
    const sha = shaOf(fullyResolved());
    const a = await signoff.signAsAgent("r1", 1, sha);
    expect(a).toMatchObject({ status: "awaiting_clinician", runState: "awaiting_clinician", signature: { role: "program_officer", userId: OFFICER_AGENT_ID, modelSha: sha } });
    const b = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha });
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ status: "locked", runState: "locked" });
    const again = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-2", modelSha: sha });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("locked");
    const st = await server.inject({ method: "GET", url: routes.status("r1", 1) });
    expect(st.json()).toMatchObject({ status: "locked", latestLocked: 1 });
  });

  it("a version saved through the API is checked, starts with zero signatures and replaces the old one", async () => {
    const { server, store, signoff } = await setup([officerFixed()]);
    const sha1 = shaOf(officerFixed());
    await signoff.signAsAgent("r1", 1, sha1);
    const body = fullyResolved();
    body.meta.version = 2;
    body.meta.parent_version = 1;
    const save = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "clinician-1", authorRole: "clinician", body } });
    expect(save.statusCode).toBe(201);
    expect(save.json()).toEqual({ n: 2, checks_status: "ok" });
    expect((await store.getRun("r1"))!.state).toBe("awaiting_officer");
    const old = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha1 });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toBe("superseded");
    const st2 = (await server.inject({ method: "GET", url: routes.status("r1", 2) })).json();
    expect(st2).toMatchObject({ status: "awaiting_officer", signatures: [] });
    expect(st2.gates.canClinicianSign).toBe(true);
  });

  it("is reachable through the agentcore http proxy", async () => {
    const { server } = await setup([fullyResolved()], "awaiting_officer", "agentcore");
    const res = await server.inject({
      method: "POST",
      url: routes.invocations(),
      payload: { action: "http", method: "GET", path: routes.status("r1", 1) },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().body).status).toBe("awaiting_officer");
  });
});

const nextBody = (m = fullyResolved(), n = 2, parent = 1) => {
  const b = structuredClone(m);
  b.meta.version = n;
  b.meta.parent_version = parent;
  return b;
};

describe("POST versions (DEC-020)", () => {
  it("422 when meta.version or meta.parent_version disagree with the version the store assigns", async () => {
    const { server, store } = await setup([fullyResolved()]);
    for (const [v, p] of [[99, 1], [2, 42], [1, null]] as const) {
      const body = fullyResolved();
      body.meta.version = v;
      body.meta.parent_version = p;
      const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "o", body } });
      expect(res.statusCode, `${v}/${p}`).toBe(422);
      expect(res.json()).toMatchObject({ error: "version_mismatch", expected: { version: 2, parent_version: 1 } });
    }
    expect(await store.listVersions("r1")).toHaveLength(1);
  });

  it("records the sha256 of the exact stored bytes and the author's role on the version", async () => {
    const { server, store, artifacts } = await setup([fullyResolved()]);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "o", authorRole: "clinician", body: nextBody() } });
    expect(res.statusCode).toBe(201);
    const v = (await store.getVersion("r1", 2))!;
    expect(v.authorRole).toBe("clinician");
    expect(v.bodySha256).toBe(createHash("sha256").update(await artifacts.get(v.artifactKey)).digest("hex"));
  });

  it("400 for an authorRole that is not a signer role", async () => {
    const { server } = await setup([fullyResolved()]);
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "o", authorRole: "admin", body: nextBody() } });
    expect(res.statusCode).toBe(400);
  });

  it("201 with checks_status failed (never plain success) when the checks after the save fail", async () => {
    const { server, store } = await setup([fullyResolved()], "awaiting_officer", "container", async () => {
      throw new Error("boom");
    });
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, author: "o", body: nextBody() } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ n: 2, checks_status: "failed" });
    expect(res.json().message).toMatch(/checks did not finish/);
    expect(await store.getVersion("r1", 2)).toBeDefined();
  });
});

describe("signer identity at the API (DEC-020)", () => {
  it("normalises the userId: the clinician's id is stored normalised", async () => {
    const { server, store, signoff } = await setup([fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    expect((await sign(server, 1, "clinician", { role: "clinician", userId: " Clinician-1\u200b", modelSha: sha })).statusCode).toBe(201);
    expect((await store.getVersion("r1", 1))!.signatures![1]!.userId).toBe("clinician-1");
  });

  it("400 for a userId with spaces inside or nothing usable", async () => {
    const { server } = await setup([fullyResolved()]);
    const sha = shaOf(fullyResolved());
    for (const userId of ["officer one", "\u200b", ""]) {
      expect((await sign(server, 1, "clinician", { role: "clinician", userId, modelSha: sha })).statusCode, JSON.stringify(userId)).toBe(400);
    }
  });
});

describe("POST reject (AR-06, RR-02)", () => {
  const body = (sha: string, over: Record<string, unknown> = {}) => ({
    role: "clinician",
    userId: "clinician-1",
    modelSha: sha,
    comment: "R3 must refer a child with chest indrawing urgently.",
    itemRef: "rules.R3",
    urgent: true,
    ...over,
  });

  it("201: the version is rejected, the run goes back to the officer, and status shows the rejection", async () => {
    const { server, signoff } = await setup([officerFixed()]);
    const sha = shaOf(officerFixed());
    await signoff.signAsAgent("r1", 1, sha);
    const res = await server.inject({ method: "POST", url: routes.reject("r1", 1), payload: body(sha) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "rejected", runState: "awaiting_officer", rejection: { urgent: true, itemRef: "rules.R3" } });
    const st = (await server.inject({ method: "GET", url: routes.status("r1", 1) })).json();
    expect(st).toMatchObject({ status: "rejected", rejection: { comment: expect.stringContaining("R3") } });
    const again = await sign(server, 1, "clinician", { role: "clinician", userId: "clinician-1", modelSha: sha });
    expect([again.statusCode, again.json().error]).toEqual([409, "rejected"]);
  });

  it("400 without a comment, with a short one, with another role or an unknown field", async () => {
    const { server } = await setup([officerFixed()]);
    const sha = shaOf(officerFixed());
    for (const b of [body(sha, { comment: undefined }), body(sha, { comment: "no" }), body(sha, { role: "program_officer" }), { ...body(sha), status: "locked" }]) {
      expect((await server.inject({ method: "POST", url: routes.reject("r1", 1), payload: b })).statusCode).toBe(400);
    }
  });

  it("409 before the officer has signed", async () => {
    const { server } = await setup([officerFixed()]);
    const res = await server.inject({ method: "POST", url: routes.reject("r1", 1), payload: body(shaOf(officerFixed())) });
    expect([res.statusCode, res.json().error]).toEqual([409, "officer_signature_required"]);
  });

  it("is a proxiable route", () => {
    expect(routes.reject("r1", 3)).toBe("/runs/r1/versions/3/reject");
    expect(routes.proxiable).toContain(routes.pattern.reject);
  });
});
