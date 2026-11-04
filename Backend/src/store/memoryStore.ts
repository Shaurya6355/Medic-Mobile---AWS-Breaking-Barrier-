import type { RunState } from "../contract/schemas.js";
import type { Comment, Run, StepRecord, Version } from "../domain/types.js";
import { AlreadyExists, Conflict } from "./store.js";
import type { AuditEvent, Store } from "./store.js";

const WORK_STATES: readonly RunState[] = ["ingesting", "extracting", "filling_logic", "checking"];

// For tests and local dev only. Every check-and-write below has no await
// between the check and the write, so each method is atomic.
export class MemoryStore implements Store {
  private runs = new Map<string, Run>();
  private steps = new Map<string, StepRecord[]>();
  private versions = new Map<string, Version[]>();
  private comments: Comment[] = [];
  private audit = new Map<string, AuditEvent[]>();

  private mustGet(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  async createRun(run: Run): Promise<void> {
    if (this.runs.has(run.runId)) throw new AlreadyExists(`Run exists: ${run.runId}`);
    this.runs.set(run.runId, structuredClone(run));
  }

  async getRun(id: string): Promise<Run | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    return structuredClone([...this.runs.values()]);
  }

  async updateRun(id: string, patch: Partial<Run>, expectedState?: RunState): Promise<Run> {
    const run = this.mustGet(id);
    if (expectedState !== undefined && run.state !== expectedState) {
      throw new Conflict(`Run ${id} is in state ${run.state}, expected ${expectedState}`);
    }
    Object.assign(run, structuredClone(patch));
    return structuredClone(run);
  }

  async appendStep(rec: StepRecord): Promise<void> {
    const list = this.steps.get(rec.runId) ?? [];
    list.push(structuredClone(rec));
    this.steps.set(rec.runId, list);
  }

  async updateStep(runId: string, step: string, attempt: number, patch: Partial<StepRecord>): Promise<void> {
    const rec = (this.steps.get(runId) ?? []).find((s) => s.step === step && s.attempt === attempt);
    if (!rec) throw new Error(`Step not found: ${runId}/${step}/${attempt}`);
    Object.assign(rec, structuredClone(patch));
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return structuredClone(this.steps.get(runId) ?? []);
  }

  async addVersion(v: Version): Promise<void> {
    const list = this.versions.get(v.runId) ?? [];
    const latest = list.length === 0 ? null : list[list.length - 1]!.n;
    const expectedN = latest === null ? 1 : latest + 1;
    if (v.n !== expectedN || v.parent !== latest) {
      throw new Conflict(`Version chain violation for ${v.runId}: got n=${v.n} parent=${v.parent}, latest=${latest}`);
    }
    list.push(structuredClone(v));
    this.versions.set(v.runId, list);
  }

  async listVersions(runId: string): Promise<Version[]> {
    return structuredClone(this.versions.get(runId) ?? []);
  }

  async getVersion(runId: string, n: number): Promise<Version | undefined> {
    const v = (this.versions.get(runId) ?? []).find((x) => x.n === n);
    return v ? structuredClone(v) : undefined;
  }

  async addComment(c: Comment): Promise<void> {
    this.comments.push(structuredClone(c));
  }

  async listComments(runId: string, n: number): Promise<Comment[]> {
    return structuredClone(this.comments.filter((c) => c.runId === runId && c.n === n));
  }

  async appendAudit(runId: string, event: AuditEvent): Promise<void> {
    const list = this.audit.get(runId) ?? [];
    list.push(structuredClone(event));
    this.audit.set(runId, list);
  }

  async listAudit(runId: string): Promise<AuditEvent[]> {
    return structuredClone(this.audit.get(runId) ?? []);
  }

  async acquireLease(runId: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const run = this.mustGet(runId);
    const lease = run.lease;
    if (lease && lease.expiresAt > now && lease.owner !== owner) return false;
    run.lease = { owner, expiresAt: now + ttlMs };
    return true;
  }

  async releaseLease(runId: string, owner: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run?.lease?.owner === owner) delete run.lease;
  }

  async listResumable(now: number): Promise<Run[]> {
    const out = [...this.runs.values()].filter(
      (r) => WORK_STATES.includes(r.state) && (!r.lease || r.lease.expiresAt <= now),
    );
    return structuredClone(out);
  }
}
