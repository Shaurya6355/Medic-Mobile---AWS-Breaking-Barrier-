import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { NotFound, artifactKey } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { Step, StepResult, StepUsage } from "../engine/step.js";
import type { Exec } from "../steps/ingest.js";
import { ingestBlocksKey, loadVersion } from "../signoff/checks.js";
import type { Store } from "../store/store.js";

/**
 * Quote-support scoring (advisory). A judge model (Strands Evals OutputEvaluator on Bedrock, run by
 * Backend/scoring/score_version.py) scores how well each cited booklet quote supports its item, so the
 * reviewer reads the low ones first.
 *
 * Never a gate: scores are stored as their own artifact, keyed to the version's modelSha. They are not
 * findings, never block a signature, never change the model and never touch golden cases or test results
 * (Medic rule 6). A scoring failure is recorded and the run carries on.
 */

// 32 items x 3 samples with 8 workers took about 2 minutes against Bedrock; leave room for throttling.
export const DEFAULT_SCORING_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScoringOptions {
  pythonBin: string;
  scriptPath: string;
  judgeModelId: string;
  region: string;
  samples?: number;
  exec?: Exec;
}

/** The parts of score_version.py's output the API and the step read. The full file is stored as written. */
export const ScoresFileSchema = z.looseObject({
  notice: z.string(),
  summary: z.looseObject({
    scored: z.number().int().min(0),
    flagged: z.number().int().min(0),
    not_scored: z.number().int().min(0),
  }),
  items: z.array(
    z.looseObject({
      item: z.string(),
      score: z.number().nullable(),
      flag: z.boolean(),
      why: z.string().nullable().optional(),
    }),
  ),
  usage: z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) }),
});
export type ScoresFile = z.infer<typeof ScoresFileSchema>;

/**
 * Runs the scorer and, when it fails, puts the end of its stderr in the error: score_version.py prints the
 * judge's own error there ("STOPPED: ... AccessDeniedException ..."), which says what to fix.
 */
export function scoringExec(timeoutMs = DEFAULT_SCORING_TIMEOUT_MS): Exec {
  return (cmd, args) =>
    new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        const why = err.killed ? `timed out after ${timeoutMs} ms` : `exit ${String(err.code ?? "?")}`;
        const tail = String(stderr ?? "").trim().split("\n").filter((l) => l.trim() !== "").slice(-2).join(" | ");
        reject(new Error(`scorer failed (${why})${tail ? `: ${tail.slice(0, 400)}` : ""}`));
      });
    });
}

export const scoresKey =(runId: string, modelSha: string): string => artifactKey(runId, "scores", `${modelSha}.json`);

export interface ScoreResult {
  key: string;
  modelSha: string;
  scores: ScoresFile;
  usage: StepUsage;
}

/** Scores version n of a run and stores the result at scoresKey(runId, modelSha). Throws on any failure. */
export async function scoreVersion(
  io: { store: Store; artifacts: ArtifactStore },
  runId: string,
  n: number,
  opts: ScoringOptions,
): Promise<ScoreResult> {
  const loaded = await loadVersion(io, runId, n);
  if (loaded.model === undefined) throw new Error(`version ${n} does not parse as a logic model; nothing to score`);
  const exec = opts.exec ?? scoringExec();
  const dir = await mkdtemp(path.join(tmpdir(), "score-"));
  try {
    const modelPath = path.join(dir, "model.json");
    const outPath = path.join(dir, "scores.json");
    await writeFile(modelPath, JSON.stringify(loaded.raw));
    const args = [
      opts.scriptPath,
      "--model", modelPath,
      "--out", outPath,
      "--judge-model", opts.judgeModelId,
      "--region", opts.region,
      "--samples", String(opts.samples ?? 3),
    ];
    // The booklet text helps the judge read each quote in its page; scoring still runs without it.
    try {
      const blocks = await io.artifacts.get(ingestBlocksKey(runId));
      const blocksPath = path.join(dir, "input_blocks.json");
      await writeFile(blocksPath, blocks);
      args.push("--blocks", blocksPath);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
    await exec(opts.pythonBin, args);
    const text = await readFile(outPath, "utf8");
    const parsed = ScoresFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`score_version.py wrote an unexpected file: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const key = scoresKey(runId, loaded.sha);
    await io.artifacts.put(key, text, "application/json");
    return {
      key,
      modelSha: loaded.sha,
      scores: parsed.data,
      usage: { inputTokens: parsed.data.usage.inputTokens, outputTokens: parsed.data.usage.outputTokens, modelId: opts.judgeModelId },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The stored scores for version n, or undefined when it has not been scored (or its body does not parse). */
export async function readScores(
  io: { store: Store; artifacts: ArtifactStore },
  runId: string,
  n: number,
): Promise<{ modelSha: string; scores: ScoresFile } | undefined> {
  const loaded = await loadVersion(io, runId, n);
  if (loaded.model === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await io.artifacts.get(scoresKey(runId, loaded.sha));
  } catch (e) {
    if (e instanceof NotFound) return undefined;
    throw e;
  }
  const parsed = ScoresFileSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return parsed.success ? { modelSha: loaded.sha, scores: parsed.data } : undefined;
}

const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

/**
 * The checks step with scoring after it, under the same name and run state (the engine runs one step per
 * state). The checks run first and decide the step; scoring then scores the version the checks checked.
 * A scoring failure never fails the step: it is recorded in artifactRefs (scoresStatus, scoresError).
 */
export function withScoring(checks: Step, opts: ScoringOptions): Step {
  return {
    name: checks.name,
    runState: checks.runState,
    async run(ctx): Promise<StepResult> {
      const res = await checks.run(ctx);
      const n = Number(res.artifactRefs.version);
      if (!Number.isSafeInteger(n) || n < 1) {
        return { ...res, artifactRefs: { ...res.artifactRefs, scoresStatus: "skipped", scoresError: "the checks step named no version" } };
      }
      try {
        const s = await scoreVersion({ store: ctx.store, artifacts: ctx.artifacts }, ctx.run.runId, n, opts);
        return {
          ...res,
          artifactRefs: {
            ...res.artifactRefs,
            scores: s.key,
            scoresStatus: "ok",
            scoresFlagged: String(s.scores.summary.flagged),
            scoresScored: String(s.scores.summary.scored),
          },
          // The checks make no model call, so the step's usage is the judge's (cost lands in the step record).
          usage: res.usage ?? s.usage,
        };
      } catch (e) {
        return { ...res, artifactRefs: { ...res.artifactRefs, scoresStatus: "failed", scoresError: short(e) } };
      }
    },
  };
}
