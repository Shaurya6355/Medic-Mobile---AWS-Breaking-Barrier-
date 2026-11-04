import { describe, expect, it } from "vitest";
import { OfficerAgent } from "../../src/agent/officerAgent.js";
import { opsAllowed } from "../../src/guard/patchPaths.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { draftV1, seed } from "../signoff/helpers.js";

const usage = { inputTokens: 10, outputTokens: 10, modelId: "m" };
const ANSWER = "Follow-up window is 3 days as the booklet states for this classification.";

async function setup(responses: any[]) {
  const s = await seed("awaiting_officer", [draftV1()]);
  const model = new FakeModelClient(responses);
  const now = () => s.clock.ms++;
  const agent = new OfficerAgent({
    store: s.store, artifacts: s.artifacts, signoff: s.signoff, model, modelId: "m", validator: parseModelValidator,
    saveDeps: { store: s.store, artifacts: s.artifacts, validator: parseModelValidator, onVersionSaved: (r, n) => s.signoff.onVersionSaved(r, n), now },
    now, budgetUsd: 1, prices: { m: { inPerMTok: 1, outPerMTok: 1 } }, leaseMs: 60_000,
  });
  return { ...s, model, agent };
}

describe("path guard: open questions", () => {
  const m = draftV1();
  const po = m.open_questions.findIndex((q) => q.route_to === "program_officer");
  const cl = m.open_questions.findIndex((q) => q.route_to === "clinician");
  const set = (i: number) => [
    { op: "replace", path: `/open_questions/${i}/status`, value: "resolved" },
    { op: "add", path: `/open_questions/${i}/resolution`, value: ANSWER },
  ];
  it("allows program_officer questions, never clinician ones, never route_to", () => {
    expect(opsAllowed(["OPEN_QUESTION"], set(po), m)).toBe(true);
    expect(opsAllowed(["OPEN_QUESTION"], set(cl), m)).toBe(false);
    expect(opsAllowed(["OPEN_QUESTION"], [{ op: "replace", path: `/open_questions/${po}/route_to`, value: "clinician" }], m)).toBe(false);
    expect(opsAllowed(["OPEN_QUESTION"], [{ op: "replace", path: `/open_questions/${po}/status`, value: "open" }], m)).toBe(false);
    expect(opsAllowed(["EMPTY_QUOTE"], set(po), m)).toBe(false);
    expect(opsAllowed(["TEAM_TEXT_TO_CONFIRM"], set(cl), m)).toBe(false);
  });
});

describe("OfficerAgent answers open questions", () => {
  it("resolves the program_officer questions, then signs; clinician questions stay open", async () => {
    const m = draftV1();
    const ops = m.open_questions.flatMap((q, i) =>
      q.route_to === "program_officer"
        ? [{ op: "replace", path: `/open_questions/${i}/status`, value: "resolved" }, { op: "add", path: `/open_questions/${i}/resolution`, value: ANSWER }]
        : [],
    );
    const s = await setup([{ raw: JSON.stringify({ ops }), usage }]);
    await s.agent.onAwaitingOfficer("r1");
    const versions = await s.store.listVersions("r1");
    expect(versions).toHaveLength(2);
    expect(versions[1]!.signatures![0]!.userId).toBe(OFFICER_AGENT_ID);
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_clinician");
    const saved = JSON.parse(new TextDecoder().decode(await s.artifacts.get(versions[1]!.artifactKey)));
    for (const q of saved.open_questions) expect(q.status).toBe(q.route_to === "program_officer" ? "resolved" : "open");
  });

  it("escalates when the patch also answers a clinician question", async () => {
    const m = draftV1();
    const cl = m.open_questions.findIndex((q) => q.route_to === "clinician");
    const ops = [{ op: "replace", path: `/open_questions/${cl}/status`, value: "resolved" }, { op: "add", path: `/open_questions/${cl}/resolution`, value: ANSWER }];
    const s = await setup([{ raw: JSON.stringify({ ops }), usage }]);
    await s.agent.onAwaitingOfficer("r1");
    expect(await s.store.listVersions("r1")).toHaveLength(1);
    expect((await s.store.getAgentState("r1", 1))!.status).toBe("escalated");
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_officer");
  });
});
