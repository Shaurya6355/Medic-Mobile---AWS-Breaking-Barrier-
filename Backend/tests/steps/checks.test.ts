import { describe, expect, it } from "vitest";
import type { StepContext } from "../../src/engine/step.js";
import type { ModelClient } from "../../src/model/modelClient.js";
import { CHECKS_VERSION, findingsKey, inputsShaOf, type FindingsRecord } from "../../src/signoff/checks.js";
import { createChecksStep } from "../../src/steps/checks.js";
import { draftV1, officerFixed, openFor, seed, shaOf, testInputs } from "../signoff/helpers.js";

const IN = inputsShaOf(testInputs());

const ctxOf = async (models = [draftV1()]) => {
  const s = await seed("checking", models);
  const run = (await s.store.getRun("r1"))!;
  const ctx: StepContext = { run, store: s.store, artifacts: s.artifacts, model: {} as ModelClient, now: () => 42 };
  return { ...s, ctx };
};

describe("checks step (BR-11, GR-03)", () => {
  const step = createChecksStep({ inputs: async () => testInputs() });

  it("is registered for the checking state", () => {
    expect(step.name).toBe("checks");
    expect(step.runState).toBe("checking");
  });

  it("checks the latest version and stores the findings keyed to its modelSha", async () => {
    const { ctx, artifacts } = await ctxOf([draftV1(), officerFixed()]);
    const res = await step.run(ctx);
    const sha = shaOf(officerFixed());
    expect(res.artifactRefs).toEqual({ findings: findingsKey("r1", sha, IN), modelSha: sha, version: "2", checksVersion: CHECKS_VERSION });
    expect(res.usage).toBeUndefined();
    const rec = JSON.parse(new TextDecoder().decode(await artifacts.get(findingsKey("r1", sha, IN)))) as FindingsRecord;
    expect(rec).toMatchObject({ runId: "r1", n: 2, modelSha: sha, checkedAt: 42, modelValid: true, claim: "PROVEN" });
    expect(rec.gates).toMatchObject({ canOfficerSign: true, canClinicianSign: false, canCompile: false });
    const blocking = rec.views.clinician.find((g) => g.severity === "blocking")!.findings;
    expect(blocking.filter((f) => f.code === "OPEN_QUESTION")).toHaveLength(openFor(officerFixed(), "clinician"));
  });

  it("fails clearly when the run has no version yet", async () => {
    const { ctx } = await ctxOf([]);
    await expect(step.run(ctx)).rejects.toThrow(/no logic model version/);
  });

  it("a body that is not a logic model gets blocking findings, never a pass", async () => {
    const { ctx, artifacts, store } = await ctxOf([draftV1()]);
    const v = (await store.getVersion("r1", 1))!;
    await artifacts.put(v.artifactKey, JSON.stringify({ not: "a model" }));
    const res = await step.run(ctx);
    const rec = JSON.parse(new TextDecoder().decode(await artifacts.get(res.artifactRefs["findings"]!))) as FindingsRecord;
    expect(rec.modelValid).toBe(false);
    expect(rec.status).toBe("fail");
    expect(rec.findings.some((f) => f.code === "SCHEMA_INVALID")).toBe(true);
    expect(rec.gates.canOfficerSign).toBe(false);
  });
});
