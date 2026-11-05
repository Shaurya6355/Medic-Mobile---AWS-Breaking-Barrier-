import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { ApprovalError } from "../../src/compiler/compileSnapshot.js";
import { compileLockedVersion } from "../../src/compiler/compileLocked.js";
import { routes } from "../../src/contract/routes.js";
import { Orchestrator } from "../../src/engine/engine.js";
import type { Step } from "../../src/engine/step.js";
import type { Model } from "../../src/logic/index.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { createChecksStep } from "../../src/steps/checks.js";
import { createFillLogicStep } from "../../src/steps/fillLogic.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";
import { demoSettings } from "../compiler/helpers.js";
import { resolveForDemo } from "../helpers/resolveForDemo.js";
import { DOC_SHA, backend, blocksText, extractionText, testInputs } from "../signoff/helpers.js";
import { readFileSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "pipeline-it-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const draftText = readFileSync(join(backend, "tests", "fixtures", "fill", "draft-cough.json"), "utf8");

/** extract output -> fill_logic -> checks -> officer -> clinician -> lock -> compile, with fakes only. */
describe("whole chain with fakes (DEC-019)", () => {
  it("blocks, refuses and finally locks and builds exactly the signed content", async () => {
    let t = 1_000;
    const now = () => t++;
    const store = new MemoryStore();
    const artifacts = new MemoryArtifactStore();
    const provided = (name: string, runState: Step["runState"], key: string[], text: string): Step => ({
      name,
      runState,
      async run() {
        await artifacts.put(artifactKey("it", ...key), text);
        return { artifactRefs: { out: artifactKey("it", ...key) } };
      },
    });
    const orchestrator = new Orchestrator({
      store,
      artifacts,
      model: new FakeModelClient([{ raw: draftText }]),
      steps: [
        provided("ingest", "ingesting", ["ingest", "input_blocks.json"], blocksText),
        provided("extract", "extracting", ["extract", "extraction_output.json"], extractionText),
        createFillLogicStep({ validator: parseModelValidator, modelId: "fake", promptPath: join(backend, "extraction", "fill_prompt.txt"), pathwayId: "cough_fast_breathing" }),
        createChecksStep({ inputs: async () => testInputs() }),
      ],
      finalState: "awaiting_officer",
      owner: "it",
      leaseMs: 60_000,
      runnerOpts: { maxAttempts: 1, backoffMs: () => 0, sleep: async () => {}, prices: {} },
      now,
    });
    const inputs = async () => testInputs();
    const signoff = new Signoff({ store, artifacts, now, inputs });
    const port = { onUploaded: (id: string) => orchestrator.onUploaded(id) } as unknown as OrchestratorPort;
    const api = buildServer({ orchestrator: port, store, artifacts, validator: parseModelValidator, presign: async (k) => k, onVersionSaved: (r, n) => signoff.onVersionSaved(r, n), signoff, maxPages: 200, now });
    const sign = async (n: number, role: string, userId: string, modelSha: string) =>
      api.inject({ method: "POST", url: routes.sign("it", n, role), payload: { role, userId, modelSha } });
    const status = async (n: number) => (await api.inject({ method: "GET", url: routes.status("it", n) })).json();
    const body = async (n: number): Promise<Model> => (await api.inject({ method: "GET", url: routes.version("it", n) })).json().body;
    // AUTH SEAM (DEC-015): the role a version is saved in comes from the body until Cognito.
    const roleOf = (author: string) => (author.startsWith("c") ? "clinician" : "program_officer");
    const save = async (parent: number, author: string, m: Model) =>
      (await api.inject({ method: "POST", url: routes.versions("it"), payload: { parentVersion: parent, author, authorRole: roleOf(author), body: m } })).json().n as number;
    // HTTP cannot save in the officer role (agent_only), so the officer agent's versions are stored in-process.
    const saveAsAgent = async (m: Model) => {
      const n = (await store.listVersions("it")).length + 1;
      const key = artifactKey("it", "versions", `v${n}-agent.json`);
      const text = JSON.stringify(m, null, 2);
      await artifacts.put(key, text, "application/json");
      await store.addVersion({ runId: "it", n, parent: n - 1, author: OFFICER_AGENT_ID, authorRole: "program_officer", createdAt: now(), artifactKey: key, bodySha256: createHash("sha256").update(text, "utf8").digest("hex") });
      await signoff.onVersionSaved("it", n);
      return n;
    };
    const compile = (n: number) => compileLockedVersion({ store, artifacts, runId: "it", n, projectDir: join(root, `v${n}-${t}`), settings: demoSettings(), now, inputs });

    // 1. pipeline to the officer
    await store.createRun({ runId: "it", state: "created", createdAt: now() });
    await orchestrator.onUploaded("it", DOC_SHA);
    expect((await store.getRun("it"))!.state).toBe("awaiting_officer");
    expect((await store.listSteps("it")).map((s) => [s.step, s.status])).toEqual([
      ["ingest", "succeeded"],
      ["extract", "succeeded"],
      ["fill_logic", "succeeded"],
      ["checks", "succeeded"],
    ]);
    const s1 = await status(1);
    // Every question a person must answer is the clinician's, so nothing holds the officer agent back here.
    expect(s1.gates.canOfficerSign).toBe(true);
    expect((await body(1)).open_questions.filter((q) => q.route_to === "program_officer")).toEqual([]);

    // 2. the clinician cannot sign before the officer agent; nobody but the agent signs as officer
    expect((await sign(1, "program_officer", "o1", s1.modelSha)).json().error).toBe("agent_only");
    expect((await sign(1, "clinician", "c1", s1.modelSha)).statusCode).toBe(409);
    await expect(compile(1)).rejects.toBeInstanceOf(ApprovalError);

    // 3. the agent signs v1; the clinician is blocked by the open questions
    await signoff.signAsAgent("it", 1, s1.modelSha);
    expect((await sign(1, "clinician", "c1", s1.modelSha)).statusCode).toBe(422);

    // 4. clinician answers -> v2: zero signatures, officer agent again, then clinician; same person refused
    const n3 = await save(1, "c1", resolveForDemo(await body(1), "clinician"));
    const s3 = await status(n3);
    expect(s3.signatures).toEqual([]);
    expect((await status(1)).status).toBe("superseded");
    await signoff.signAsAgent("it", n3, s3.modelSha);
    expect((await sign(n3, "clinician", OFFICER_AGENT_ID, s3.modelSha)).statusCode).toBe(400);
    expect((await sign(n3, "clinician", "c1", s1.modelSha)).statusCode).toBe(409);
    const locked = await sign(n3, "clinician", "c1", s3.modelSha);
    expect(locked.statusCode).toBe(201);
    expect(locked.json().status).toBe("locked");
    expect((await store.getRun("it"))!.state).toBe("locked");

    // 5. compile: unlocked refused, locked built from exactly the signed sha
    await expect(compile(1)).rejects.toBeInstanceOf(ApprovalError);
    const built = await compile(n3);
    expect(built.manifest.buildKind).toBe("release");
    expect(built.manifest.modelSha).toBe(s3.modelSha);

    // 6. edit after lock: new version, zero signatures, locked one still the releasable one
    const edited = await body(n3);
    edited.meta.parent_version = edited.meta.version;
    edited.meta.version += 1;
    const n4 = await saveAsAgent(edited);
    const s4 = await status(n4);
    expect([s4.status, s4.signatures.length, s4.latestLocked]).toEqual(["awaiting_officer", 0, n3]);
    expect((await status(n3)).status).toBe("locked");
    await expect(compile(n4)).rejects.toBeInstanceOf(ApprovalError);
    await api.close();
    // Every signature and the release build run the checks again (DEC-020), so this chain takes a few seconds.
  }, 60_000);
});
