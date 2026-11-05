import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { artifactKey } from "../../src/artifacts/artifactStore.js";
import { routes } from "../../src/contract/routes.js";
import type { Step, StepContext } from "../../src/engine/step.js";
import type { ModelClient } from "../../src/model/modelClient.js";
import { readScores, scoresKey, scoreVersion, scoringExec, withScoring, type ScoringOptions } from "../../src/scoring/scoreVersion.js";
import { Signoff } from "../../src/signoff/signoff.js";
import { createChecksStep } from "../../src/steps/checks.js";
import type { Exec } from "../../src/steps/ingest.js";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { draftV1, officerFixed, seed, shaOf, testInputs } from "../signoff/helpers.js";

const SCORES = {
  notice: "Advisory only",
  summary: { scored: 2, flagged: 1, not_scored: 1, to_read_closely: 1, to_glance_at: 1 },
  items: [
    { item: "rules/R3", kind: "rule", score: 0.5, flag: true, why: "score 0.50 is below 0.7" },
    { item: "questions/cough", kind: "question", score: 1, flag: false, why: null },
  ],
  not_scored: [{ item: "rules/R1", kind: "rule", why: "no quote (origin team)" }],
  usage: { inputTokens: 1200, outputTokens: 80 },
};

const argOf = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

/** A stand-in for python3 score_version.py: records the call and writes `out` to --out. */
function fakeExec(out: unknown = SCORES) {
  const calls: { cmd: string; args: string[]; model?: unknown; blocks?: boolean }[] = [];
  const exec: Exec = async (cmd, args) => {
    const modelPath = argOf(args, "--model")!;
    calls.push({ cmd, args, model: JSON.parse(await readFile(modelPath, "utf8")), blocks: argOf(args, "--blocks") !== undefined });
    await writeFile(argOf(args, "--out")!, typeof out === "string" ? out : JSON.stringify(out));
  };
  return { exec, calls };
}

const opts = (exec: Exec): ScoringOptions => ({ pythonBin: "py", scriptPath: "score_version.py", judgeModelId: "judge-1", region: "us-west-2", exec });

const ctxOf = async (models = [draftV1()]) => {
  const s = await seed("checking", models);
  const run = (await s.store.getRun("r1"))!;
  const ctx: StepContext = { run, store: s.store, artifacts: s.artifacts, model: {} as ModelClient, now: () => 42 };
  return { ...s, ctx };
};

const checks = createChecksStep({ inputs: async () => testInputs() });

describe("scoreVersion", () => {
  it("passes the version body, the booklet text and the judge to the script, and stores the scores by modelSha", async () => {
    const { store, artifacts } = await ctxOf([draftV1(), officerFixed()]);
    const { exec, calls } = fakeExec();
    const res = await scoreVersion({ store, artifacts }, "r1", 2, opts(exec));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("py");
    expect(argOf(calls[0]!.args, "--judge-model")).toBe("judge-1");
    expect(argOf(calls[0]!.args, "--samples")).toBe("3");
    expect(calls[0]!.blocks).toBe(true);
    expect(shaOf(calls[0]!.model as never)).toBe(shaOf(officerFixed()));
    expect(res.key).toBe(scoresKey("r1", shaOf(officerFixed())));
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 80, modelId: "judge-1" });
    expect(JSON.parse(new TextDecoder().decode(await artifacts.get(res.key)))).toEqual(SCORES);
  });

  it("runs without the booklet text when the run has none", async () => {
    const { store, artifacts } = await ctxOf();
    const blocksKey = artifactKey("r1", "ingest", "input_blocks.json");
    (artifacts as unknown as { objects: Map<string, Uint8Array> }).objects.delete(blocksKey);
    const { exec, calls } = fakeExec();
    await scoreVersion({ store, artifacts }, "r1", 1, opts(exec));
    expect(calls[0]!.blocks).toBe(false);
  });

  it("refuses a body that is not a logic model and output that is not a scores file", async () => {
    const { store, artifacts } = await ctxOf();
    await expect(scoreVersion({ store, artifacts }, "r1", 1, opts(fakeExec({ nope: 1 }).exec))).rejects.toThrow(/unexpected file/);
    const v = (await store.getVersion("r1", 1))!;
    await artifacts.put(v.artifactKey, JSON.stringify({ not: "a model" }));
    await expect(scoreVersion({ store, artifacts }, "r1", 1, opts(fakeExec().exec))).rejects.toThrow(/does not parse/);
  });
});

describe("withScoring around the checks step", () => {
  it("keeps the checks step's name and state, so the engine runs it in place of the checks", () => {
    const step = withScoring(checks, opts(fakeExec().exec));
    expect(step.name).toBe("checks");
    expect(step.runState).toBe("checking");
  });

  it("runs the checks, then scores the version they checked, and records the judge's usage", async () => {
    const { ctx, artifacts } = await ctxOf([draftV1(), officerFixed()]);
    const res = await withScoring(checks, opts(fakeExec().exec)).run(ctx);
    const sha = shaOf(officerFixed());
    expect(res.artifactRefs).toMatchObject({ version: "2", modelSha: sha, scores: scoresKey("r1", sha), scoresStatus: "ok", scoresFlagged: "1", scoresScored: "2" });
    expect(await artifacts.exists(res.artifactRefs["findings"]!)).toBe(true);
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 80, modelId: "judge-1" });
  });

  it("a scoring failure never fails the step: the checks result stands and the error is recorded", async () => {
    const { ctx, artifacts } = await ctxOf();
    const failing: Exec = async () => {
      throw new Error("scorer failed (exit 2): STOPPED: nothing was scored. | AccessDeniedException: no access");
    };
    const res = await withScoring(checks, opts(failing)).run(ctx);
    expect(res.artifactRefs["scoresStatus"]).toBe("failed");
    expect(res.artifactRefs["scoresError"]).toMatch(/AccessDeniedException/);
    expect(res.artifactRefs["scores"]).toBeUndefined();
    expect(await artifacts.exists(res.artifactRefs["findings"]!)).toBe(true);
    expect(res.usage).toBeUndefined();
  });

  it("a checks failure still fails the step, and scoring does not run", async () => {
    const { ctx } = await ctxOf([]);
    const { exec, calls } = fakeExec();
    await expect(withScoring(checks, opts(exec)).run(ctx)).rejects.toThrow(/no logic model version/);
    expect(calls).toHaveLength(0);
  });

  it("skips scoring when the inner step names no version", async () => {
    const { ctx } = await ctxOf();
    const inner: Step = { name: "checks", runState: "checking", run: async () => ({ artifactRefs: {} }) };
    const { exec, calls } = fakeExec();
    const res = await withScoring(inner, opts(exec)).run(ctx);
    expect(res.artifactRefs["scoresStatus"]).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

describe("scoringExec", () => {
  it("puts the end of the script's stderr in the error", async () => {
    const exec = scoringExec(30_000);
    await expect(
      exec(process.execPath, ["-e", "console.error('scoring the clean model...'); console.error('STOPPED: AccessDeniedException: no access'); process.exit(2)"]),
    ).rejects.toThrow(/exit 2.*STOPPED: AccessDeniedException/);
    await expect(exec(process.execPath, ["-e", "process.exit(0)"])).resolves.toBeUndefined();
  });
});

describe("GET scores", () => {
  const orchestrator: OrchestratorPort = {
    createRun: vi.fn(),
    resume: vi.fn(async () => {}),
    prepareResume: vi.fn(async () => {}),
    onUploaded: vi.fn(async () => {}),
    resumeAll: vi.fn(async () => {}),
    activeCount: () => 0,
    lastStatusChange: () => undefined,
  };

  async function setup(models = [draftV1()]) {
    const s = await seed("awaiting_officer", models);
    const signoff = new Signoff({ store: s.store, artifacts: s.artifacts, now: () => s.clock.ms++, inputs: async () => testInputs() });
    const server = buildServer({
      orchestrator,
      store: s.store,
      artifacts: s.artifacts,
      validator: parseModelValidator,
      presign: async (k) => k,
      onVersionSaved: async () => {},
      signoff,
      maxPages: 50,
      runMode: "container",
    });
    return { ...s, server };
  }

  it("is a contract route the HTTP API and the agentcore proxy can reach", () => {
    expect(routes.scores("r1", 2)).toBe("/runs/r1/versions/2/scores");
    expect(routes.proxiable).toContain(routes.pattern.scores);
  });

  it("says not_scored, then returns the stored scores for the version's current content", async () => {
    const { server, store, artifacts } = await setup();
    const before = await server.inject({ method: "GET", url: routes.scores("r1", 1) });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ runId: "r1", n: 1, status: "not_scored" });

    await scoreVersion({ store, artifacts }, "r1", 1, opts(fakeExec().exec));
    const after = await server.inject({ method: "GET", url: routes.scores("r1", 1) });
    expect(after.json()).toMatchObject({ status: "scored", modelSha: shaOf(draftV1()), summary: { flagged: 1 }, items: SCORES.items });
  });

  it("scores of other content are not served for a version", async () => {
    const { server, store, artifacts } = await setup([draftV1(), officerFixed()]);
    await scoreVersion({ store, artifacts }, "r1", 1, opts(fakeExec().exec));
    expect((await readScores({ store, artifacts }, "r1", 2))).toBeUndefined();
    expect((await server.inject({ method: "GET", url: routes.scores("r1", 2) })).json()).toMatchObject({ status: "not_scored" });
  });

  it("404 for an unknown version, 400 for a bad version number", async () => {
    const { server } = await setup();
    expect((await server.inject({ method: "GET", url: routes.scores("r1", 9) })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/runs/r1/versions/x/scores" })).statusCode).toBe(400);
  });
});
