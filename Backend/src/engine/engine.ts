import { randomUUID } from "node:crypto";
import type { RunState } from "../contract/schemas.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { canTransition } from "../domain/stateMachine.js";
import type { Run } from "../domain/types.js";
import type { ModelClient } from "../model/modelClient.js";
import type { Store } from "../store/store.js";
import { runStep, type RunStepOptions } from "./runner.js";
import type { Step } from "./step.js";

const MAX_ERROR_CHARS = 500;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface OrchestratorOptions {
  store: Store;
  artifacts: ArtifactStore;
  model: ModelClient;
  // The fixed flow, in order. Each step runs while the run is in its runState.
  steps: Step[];
  owner: string;
  leaseMs: number;
  runnerOpts: Omit<RunStepOptions, "firstAttempt">;
  now?: () => number;
}

export class Orchestrator {
  private readonly store: Store;
  private readonly artifacts: ArtifactStore;
  private readonly model: ModelClient;
  private readonly steps: Step[];
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly runnerOpts: Omit<RunStepOptions, "firstAttempt">;
  private readonly now: () => number;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.artifacts = opts.artifacts;
    this.model = opts.model;
    this.steps = opts.steps;
    this.owner = opts.owner;
    this.leaseMs = opts.leaseMs;
    this.runnerOpts = opts.runnerOpts;
    this.now = opts.now ?? Date.now;
  }

  async createRun(pages: number[] | undefined, filename: string): Promise<Run> {
    const createdAt = this.now();
    const run: Run = { runId: randomUUID(), state: "created", createdAt };
    if (pages !== undefined) run.pages = pages;
    await this.store.createRun(run);
    await this.store.appendAudit(run.runId, {
      at: createdAt,
      type: "run_state",
      detail: { from: null, to: "created", filename },
    });
    return run;
  }

  // Idempotent: a repeated upload event for a run past `created` does nothing.
  async onUploaded(runId: string, docSha256?: string): Promise<void> {
    const run = await this.mustGet(runId);
    if (run.state !== "created") return;
    if (docSha256 !== undefined) await this.store.updateRun(runId, { docSha256 }, "created");
    await this.advance(runId);
  }

  async advance(runId: string): Promise<void> {
    if (!(await this.renewLease(runId))) return;
    let threw = false;
    let current: Step | undefined;
    try {
      let run = await this.mustGet(runId);
      if (run.state === "created") {
        const first = this.steps[0];
        if (!first) return;
        run = await this.transition(run, first.runState);
      }

      for (;;) {
        const index = this.steps.findIndex((s) => s.runState === run.state);
        if (index === -1) return;
        const step = this.steps[index]!;
        current = step;
        // Another owner may have taken the run after our lease lapsed: stop quietly.
        if (!(await this.renewLease(runId))) return;

        const records = (await this.store.listSteps(runId)).filter((r) => r.step === step.name);
        // A succeeded record means the step's outputs already exist; skip it.
        if (!records.some((r) => r.status === "succeeded")) {
          for (const r of records.filter((r) => r.status === "running")) {
            await this.store.updateStep(runId, step.name, r.attempt, {
              status: "failed",
              endedAt: this.now(),
              error: "abandoned",
            });
          }
          const firstAttempt = records.reduce((max, r) => Math.max(max, r.attempt), 0) + 1;
          const ctx = { run, store: this.store, artifacts: this.artifacts, model: this.model, now: this.now };
          const rec = await runStep(step, ctx, { ...this.runnerOpts, firstAttempt });
          if (!(await this.renewLease(runId))) return;
          if (rec.status === "failed") {
            await this.transition(run, "failed", { currentStep: step.name });
            return;
          }
        }

        run = await this.transition(run, this.steps[index + 1]?.runState ?? "in_review");
      }
    } catch (e) {
      threw = true;
      await this.failAfterError(runId, current);
      throw e;
    } finally {
      try {
        await this.store.releaseLease(runId, this.owner);
      } catch (releaseError) {
        // Never mask an error from the body.
        if (!threw) throw releaseError;
      }
    }
  }

  // Re-enter a failed run at the step that failed.
  async resume(runId: string): Promise<void> {
    const run = await this.mustGet(runId);
    if (run.state !== "failed") throw new Error(`Run ${runId} is not failed (state ${run.state})`);
    const step = this.steps.find((s) => s.name === run.currentStep);
    if (!step) throw new Error(`Run ${runId} has no resumable step: ${run.currentStep}`);
    await this.transition(run, step.runState, { currentStep: undefined });
    await this.advance(runId);
  }

  // Never throws for a single run's failure: records resume_error on it and moves on.
  async resumeAll(): Promise<void> {
    for (const run of await this.store.listResumable(this.now())) {
      try {
        await this.advance(run.runId);
      } catch (e) {
        try {
          await this.store.appendAudit(run.runId, {
            at: this.now(),
            type: "resume_error",
            detail: { error: errorText(e).slice(0, MAX_ERROR_CHARS) },
          });
        } catch {
          // Best effort only.
        }
      }
    }
  }

  private renewLease(runId: string): Promise<boolean> {
    return this.store.acquireLease(runId, this.owner, this.leaseMs, this.now());
  }

  // Best effort after an unexpected error: if we still hold the run, move it to
  // failed so it does not sit in a working state forever. Errors here are dropped;
  // the caller rethrows the original.
  private async failAfterError(runId: string, current: Step | undefined): Promise<void> {
    try {
      if (!(await this.renewLease(runId))) return;
      const run = await this.mustGet(runId);
      // A created run is left as is: a redelivered upload event retries it.
      if (run.state === "failed" || run.state === "created" || !canTransition(run.state, "failed")) return;
      const step = this.steps.find((s) => s.runState === run.state) ?? current;
      await this.transition(run, "failed", { currentStep: step?.name });
    } catch {
      // Best effort only.
    }
  }

  private async mustGet(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  private async transition(run: Run, to: RunState, extra: Partial<Run> = {}): Promise<Run> {
    const from = run.state;
    if (!canTransition(from, to)) throw new Error(`Illegal transition for ${run.runId}: ${from} -> ${to}`);
    const updated = await this.store.updateRun(run.runId, { ...extra, state: to }, from);
    await this.store.appendAudit(run.runId, { at: this.now(), type: "run_state", detail: { from, to } });
    return updated;
  }
}
