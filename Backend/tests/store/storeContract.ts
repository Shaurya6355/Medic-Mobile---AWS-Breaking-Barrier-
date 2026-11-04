import { describe, it, expect } from "vitest";
import type { Store } from "../../src/store/store.js";
import { AlreadyExists, Conflict } from "../../src/store/store.js";
import type { Run, StepRecord, Version } from "../../src/domain/types.js";

const run = (runId: string, over: Partial<Run> = {}): Run => ({
  runId,
  state: "created",
  createdAt: 1000,
  ...over,
});

const step = (runId: string, name: string, attempt: number): StepRecord => ({
  runId,
  step: name,
  attempt,
  status: "running",
  startedAt: 1,
  inputTokens: 0,
  outputTokens: 0,
  artifactRefs: {},
});

const ver = (runId: string, n: number, parent: number | null): Version => ({
  runId,
  n,
  parent,
  author: "ai",
  createdAt: 1,
  artifactKey: `k/${n}`,
});

export function runStoreContract(name: string, makeStore: () => Store | Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    it("creates and reads a run; unknown run is undefined", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      expect(await s.getRun("r1")).toEqual(run("r1"));
      expect(await s.getRun("nope")).toBeUndefined();
      expect((await s.listRuns()).map((r) => r.runId)).toEqual(["r1"]);
    });

    it("rejects duplicate createRun with AlreadyExists", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await expect(s.createRun(run("r1"))).rejects.toBeInstanceOf(AlreadyExists);
    });

    it("returns copies that cannot mutate stored state", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      const got = await s.getRun("r1");
      got!.state = "failed";
      expect((await s.getRun("r1"))!.state).toBe("created");
    });

    it("updateRun patches, and honours expectedState", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      const updated = await s.updateRun("r1", { state: "ingesting" }, "created");
      expect(updated.state).toBe("ingesting");
      await expect(s.updateRun("r1", { state: "extracting" }, "created")).rejects.toBeInstanceOf(Conflict);
      expect((await s.getRun("r1"))!.state).toBe("ingesting");
      await expect(s.updateRun("missing", { state: "failed" })).rejects.toThrow();
    });

    it("appends, updates and lists steps", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.appendStep(step("r1", "extract", 1));
      await s.appendStep(step("r1", "extract", 2));
      await s.updateStep("r1", "extract", 1, { status: "succeeded", outputTokens: 5 });
      const steps = await s.listSteps("r1");
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ attempt: 1, status: "succeeded", outputTokens: 5 });
      expect(steps[1]).toMatchObject({ attempt: 2, status: "running" });
      await expect(s.updateStep("r1", "nope", 1, { status: "failed" })).rejects.toThrow();
    });

    it("enforces the single version chain", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await expect(s.addVersion(ver("r1", 2, null))).rejects.toBeInstanceOf(Conflict);
      await s.addVersion(ver("r1", 1, null));
      await expect(s.addVersion(ver("r1", 2, null))).rejects.toBeInstanceOf(Conflict);
      await expect(s.addVersion(ver("r1", 3, 2))).rejects.toBeInstanceOf(Conflict);
      await s.addVersion(ver("r1", 2, 1));
      expect((await s.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
      expect((await s.getVersion("r1", 2))!.parent).toBe(1);
      expect(await s.getVersion("r1", 9)).toBeUndefined();
    });

    it("concurrent addVersion with the same parent: exactly one succeeds", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.addVersion(ver("r1", 1, null));
      const results = await Promise.allSettled([
        s.addVersion(ver("r1", 2, 1)),
        s.addVersion({ ...ver("r1", 2, 1), author: "other" }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
      expect(await s.listVersions("r1")).toHaveLength(2);
    });

    it("stores comments per run and version", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      const c = { runId: "r1", n: 1, itemRef: "a", author: "u", text: "hi", createdAt: 1 };
      await s.addComment(c);
      await s.addComment({ ...c, n: 2, text: "other" });
      expect(await s.listComments("r1", 1)).toEqual([c]);
    });

    it("audit is append-only and ordered", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.appendAudit("r1", { at: 1, type: "a", detail: { x: 1 } });
      await s.appendAudit("r1", { at: 2, type: "b", detail: null });
      expect((await s.listAudit("r1")).map((e) => e.type)).toEqual(["a", "b"]);
      const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(s));
      expect(keys.filter((k) => /audit/i.test(k)).sort()).toEqual(["appendAudit", "listAudit"]);
    });

    it("acquireLease: exclusive until expiry, renewable by owner", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      expect(await s.acquireLease("r1", "a", 100, 1000)).toBe(true);
      expect((await s.getRun("r1"))!.lease).toEqual({ owner: "a", expiresAt: 1100 });
      expect(await s.acquireLease("r1", "b", 100, 1050)).toBe(false);
      expect(await s.acquireLease("r1", "a", 100, 1050)).toBe(true);
      expect(await s.acquireLease("r1", "b", 100, 1149)).toBe(false);
      expect(await s.acquireLease("r1", "b", 100, 1150)).toBe(true);
      await expect(s.acquireLease("missing", "a", 1, 1)).rejects.toThrow();
    });

    it("listResumable: work states without a live lease only", async () => {
      const s = await makeStore();
      await s.createRun(run("created", { state: "created" }));
      await s.createRun(run("review", { state: "in_review" }));
      await s.createRun(run("failed", { state: "failed" }));
      await s.createRun(run("free", { state: "extracting" }));
      await s.createRun(run("leased", { state: "checking" }));
      await s.createRun(run("expired", { state: "ingesting" }));
      await s.acquireLease("leased", "a", 200, 1000);
      await s.acquireLease("expired", "a", 100, 1000);
      const ids = (await s.listResumable(1100)).map((r) => r.runId).sort();
      expect(ids).toEqual(["expired", "free"]);
      const ids2 = (await s.listResumable(1050)).map((r) => r.runId).sort();
      expect(ids2).toEqual(["free"]);
    });

    it("concurrent acquireLease by two owners: exactly one wins", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      const results = await Promise.all([
        s.acquireLease("r1", "a", 100, 1000),
        s.acquireLease("r1", "b", 100, 1000),
      ]);
      expect(results.filter((x) => x === true)).toHaveLength(1);
    });

    it("concurrent updateRun with the same expectedState: one succeeds, one Conflict", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      const results = await Promise.allSettled([
        s.updateRun("r1", { state: "ingesting" }, "created"),
        s.updateRun("r1", { state: "failed" }, "created"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason).toBeInstanceOf(Conflict);
    });

    it("updateRun with an undefined value clears the field", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.acquireLease("r1", "a", 1000, 1000);
      const updated = await s.updateRun("r1", { lease: undefined });
      expect(updated.lease).toBeUndefined();
      expect((await s.getRun("r1"))!.lease).toBeUndefined();
      expect(await s.acquireLease("r1", "b", 100, 1100)).toBe(true);
    });

    it("updateStep with an undefined value clears the field", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.appendStep({ ...step("r1", "extract", 1), error: "boom" });
      await s.updateStep("r1", "extract", 1, { error: undefined });
      expect((await s.listSteps("r1"))[0]!.error).toBeUndefined();
    });
  });
}
