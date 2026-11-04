import { describe, expect, it } from "vitest";
import { OfficerAgent } from "../../src/agent/officerAgent.js";
import { runBackground } from "../../src/api/background.js";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { routes } from "../../src/contract/routes.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { officerFixed, seed } from "../signoff/helpers.js";

const orchestrator: OrchestratorPort = {
  createRun: async () => { throw new Error("unused"); },
  resume: async () => {}, prepareResume: async () => {}, onUploaded: async () => {}, resumeAll: async () => {},
  activeCount: () => 0, lastStatusChange: () => undefined,
};

describe("officer agent triggers (index.ts wiring)", () => {
  it("a saved version triggers the agent, which signs; triggering twice is idempotent", async () => {
    const s = await seed("awaiting_officer", [officerFixed()]);
    const now = () => s.clock.ms++;
    const model = new FakeModelClient([]);
    const agent = new OfficerAgent({
      store: s.store, artifacts: s.artifacts, signoff: s.signoff, model, modelId: "m", validator: parseModelValidator,
      saveDeps: { store: s.store, artifacts: s.artifacts, validator: parseModelValidator, onVersionSaved: (r, n) => s.signoff.onVersionSaved(r, n), now },
      now, budgetUsd: 1, prices: {}, leaseMs: 60_000,
    });
    const trigger = (runId: string) => runBackground("lambda", agent.onAwaitingOfficer(runId), () => {});
    const rejected: string[] = [];
    const server = buildServer({
      orchestrator, store: s.store, artifacts: s.artifacts, validator: parseModelValidator, presign: async (k) => k,
      onVersionSaved: async (r, n) => { await s.signoff.onVersionSaved(r, n); await trigger(r); },
      onRejected: async (r) => { rejected.push(r); await trigger(r); },
      signoff: s.signoff, maxPages: 50, now,
    });
    const body = { ...officerFixed(), meta: { ...officerFixed().meta, version: 2, parent_version: 1 } };
    const res = await server.inject({ method: "POST", url: routes.versions("r1"), payload: { parentVersion: 1, body, author: "dr.amy", authorRole: "clinician" } });
    expect(res.statusCode, res.body).toBe(201);
    const v2 = await s.store.getVersion("r1", 2);
    expect(v2!.signatures?.[0]?.userId).toBe(OFFICER_AGENT_ID);
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_clinician");
    await trigger("r1");
    await trigger("r1");
    expect((await s.store.getVersion("r1", 2))!.signatures).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
  });
});
