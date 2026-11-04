import { describe, expect, it, vi } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { routes } from "../../src/contract/routes.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { FlagsDocumentSchema } from "../../src/validation/flags.js";
import { draftV1, seed, shaOf, testInputs } from "../signoff/helpers.js";

const orchestrator: OrchestratorPort = {
  createRun: vi.fn(),
  resume: vi.fn(async () => {}),
  prepareResume: vi.fn(async () => {}),
  onUploaded: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  activeCount: () => 0,
  lastStatusChange: () => undefined,
};

async function setup(withSecondDraft: boolean) {
  const s = await seed("awaiting_officer", [draftV1()]);
  const second = draftV1();
  second.scope.age_months_below = 59;
  const signoff = new Signoff({
    store: s.store,
    artifacts: s.artifacts,
    now: () => s.clock.ms++,
    inputs: async () => ({ ...testInputs(), ...(withSecondDraft ? { crossCheck: { model: second } } : {}) }),
  });
  const server = buildServer({
    orchestrator,
    store: s.store,
    artifacts: s.artifacts,
    validator: parseModelValidator,
    presign: async (k) => k,
    onVersionSaved: (runId, n) => signoff.onVersionSaved(runId, n),
    signoff,
    maxPages: 50,
    runMode: "container",
  });
  return { ...s, server };
}

describe("GET /runs/:id/versions/:n/flags (what the front end reads)", () => {
  it("is part of the contract and reachable through the API proxy list", () => {
    expect(routes.flags("r1", 2)).toBe("/runs/r1/versions/2/flags");
    expect(routes.proxiable).toContain(routes.pattern.flags);
  });

  it("serves the stored flags document of a version", async () => {
    const { server } = await setup(true);
    const res = await server.inject({ method: "GET", url: routes.flags("r1", 1) });
    expect(res.statusCode).toBe(200);
    const doc = FlagsDocumentSchema.parse(res.json());
    expect(doc).toMatchObject({ runId: "r1", n: 1, modelSha: shaOf(draftV1()), comparison: "ran" });
    expect(doc.flags.some((f) => f.code === "CROSS_CHECK_SCOPE_DIFFERS")).toBe(true);
    expect(doc.flags.every((f) => f.messages.clinician !== "" && f.status === "open")).toBe(true);
  });

  it("serves an empty document that says the comparison did not run when there is no second draft", async () => {
    const { server } = await setup(false);
    const doc = FlagsDocumentSchema.parse((await server.inject({ method: "GET", url: routes.flags("r1", 1) })).json());
    expect(doc).toMatchObject({ comparison: "not_run", flags: [], secondDraftSha: null });
  });

  it("answers 404 for a run or version that does not exist and 400 for a bad version number", async () => {
    const { server } = await setup(true);
    expect((await server.inject({ method: "GET", url: routes.flags("nope", 1) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: routes.flags("r1", 9) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/runs/r1/versions/abc/flags" })).statusCode).toBe(400);
  });
});
