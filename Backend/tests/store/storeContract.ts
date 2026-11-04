import { describe, it, expect } from "vitest";
import type { Store } from "../../src/store/store.js";
import { AlreadyExists, Conflict } from "../../src/store/store.js";
import type { Rejection, Run, Signature, StepRecord, Version } from "../../src/domain/types.js";

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

const SHA = "c".repeat(64);
const sig = (n: number, role: Signature["role"], userId: string, over: Partial<Signature> = {}): Signature => ({
  runId: "r1",
  n,
  modelSha: SHA,
  role,
  userId,
  signedAt: role === "program_officer" ? 100 : 200,
  ...over,
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

    it("rejects a second record for the same step and attempt with AlreadyExists", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.appendStep(step("r1", "validate", 1));
      await expect(s.appendStep(step("r1", "validate", 1))).rejects.toBeInstanceOf(AlreadyExists);
      await s.appendStep(step("r1", "validate", 2));
      expect(await s.listSteps("r1")).toHaveLength(2);
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

    it("releaseLease: owner release frees the run at once; non-owner release is a no-op", async () => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.acquireLease("r1", "a", 1000, 1000);
      await s.releaseLease("r1", "b");
      expect((await s.getRun("r1"))!.lease).toEqual({ owner: "a", expiresAt: 2000 });
      expect(await s.acquireLease("r1", "b", 100, 1100)).toBe(false);
      await s.releaseLease("r1", "a");
      expect((await s.getRun("r1"))!.lease).toBeUndefined();
      expect(await s.acquireLease("r1", "b", 100, 1100)).toBe(true);
      await s.releaseLease("missing", "a");
      expect(await s.getRun("missing")).toBeUndefined();
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
    // ---------- sign-off (BRD AR-02, AR-03, AR-05, AR-07; DEC-019) ----------
    const twoVersions = async (): Promise<Store> => {
      const s = await makeStore();
      await s.createRun(run("r1"));
      await s.addVersion(ver("r1", 1, null));
      await s.addVersion(ver("r1", 2, 1));
      return s;
    };

    it("a new version starts with zero signatures and as a draft (AR-02)", async () => {
      const s = await twoVersions();
      const v = (await s.getVersion("r1", 2))!;
      expect(v.signatures ?? []).toEqual([]);
      expect(v.status ?? "draft").toBe("draft");
    });

    it("records the officer then the clinician and locks the version (AR-03, AR-05)", async () => {
      const s = await twoVersions();
      const afterOfficer = await s.addSignature(sig(2, "program_officer", "o1"));
      expect(afterOfficer.signatures).toEqual([sig(2, "program_officer", "o1")]);
      expect(afterOfficer.status ?? "draft").toBe("draft");
      const afterClinician = await s.addSignature(sig(2, "clinician", "c1"));
      expect(afterClinician.status).toBe("locked");
      expect(afterClinician.lockedAt).toBe(200);
      expect(afterClinician.signatures).toEqual([sig(2, "program_officer", "o1"), sig(2, "clinician", "c1")]);
      expect(await s.getVersion("r1", 2)).toEqual(afterClinician);
      // The body pointer is never rewritten (AR-01).
      expect(afterClinician.artifactKey).toBe("k/2");
    });

    it("refuses a clinician signature before the officer's (AR-03)", async () => {
      const s = await twoVersions();
      await expect(s.addSignature(sig(2, "clinician", "c1"))).rejects.toBeInstanceOf(Conflict);
      expect((await s.getVersion("r1", 2))!.signatures ?? []).toEqual([]);
    });

    it("refuses a second officer signature", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      await expect(s.addSignature(sig(2, "program_officer", "o2"))).rejects.toBeInstanceOf(Conflict);
    });

    it("refuses the same person signing both roles (separation of duties)", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "same"));
      await expect(s.addSignature(sig(2, "clinician", "same"))).rejects.toBeInstanceOf(Conflict);
      expect((await s.getVersion("r1", 2))!.status ?? "draft").toBe("draft");
    });

    it("refuses a clinician signature on other content than the officer signed (AR-07)", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      await expect(s.addSignature(sig(2, "clinician", "c1", { modelSha: "d".repeat(64) }))).rejects.toBeInstanceOf(Conflict);
    });

    it("refuses any signature on a locked version", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      await s.addSignature(sig(2, "clinician", "c1"));
      await expect(s.addSignature(sig(2, "clinician", "c2"))).rejects.toBeInstanceOf(Conflict);
      await expect(s.addSignature(sig(2, "program_officer", "o2"))).rejects.toBeInstanceOf(Conflict);
    });

    it("refuses a signature on a version that is not the latest (an edit starts over, AR-04)", async () => {
      const s = await twoVersions();
      await expect(s.addSignature(sig(1, "program_officer", "o1"))).rejects.toBeInstanceOf(Conflict);
    });

    it("refuses a signature on a version that does not exist", async () => {
      const s = await twoVersions();
      await expect(s.addSignature(sig(7, "program_officer", "o1"))).rejects.toBeInstanceOf(Conflict);
    });

    it("a locked version stays locked after a newer version is added (AR-09)", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      await s.addSignature(sig(2, "clinician", "c1"));
      await s.addVersion(ver("r1", 3, 2));
      expect((await s.getVersion("r1", 2))!.status).toBe("locked");
      expect((await s.getVersion("r1", 3))!.signatures ?? []).toEqual([]);
    });

    // ---------- DEC-020: normalised identity, settings binding, rejection (AR-06) ----------
    it("separation of duties compares normalised userIds (case, spaces, zero-width, fullwidth)", async () => {
      for (const variant of ["Alice", " alice ", "alice\u200b", "\uff41\uff4c\uff49\uff43\uff45", "ALICE\ufeff"]) {
        const s = await twoVersions();
        await s.addSignature(sig(2, "program_officer", "alice"));
        await expect(s.addSignature(sig(2, "clinician", variant)), JSON.stringify(variant)).rejects.toBeInstanceOf(Conflict);
      }
    });

    it("stores the normalised userId", async () => {
      const s = await twoVersions();
      const v = await s.addSignature(sig(2, "program_officer", " Officer.One "));
      expect(v.signatures![0]!.userId).toBe("officer.one");
    });

    it("refuses a clinician signature given with other compile settings than the officer's", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1", { settingsSha: "1".repeat(64) }));
      await expect(s.addSignature(sig(2, "clinician", "c1", { settingsSha: "2".repeat(64) }))).rejects.toBeInstanceOf(Conflict);
      const v = await s.addSignature(sig(2, "clinician", "c1", { settingsSha: "1".repeat(64) }));
      expect(v.status).toBe("locked");
    });

    const rejection = (over: Partial<Rejection> = {}): Rejection => ({
      role: "clinician",
      userId: "c1",
      modelSha: SHA,
      comment: "R3 must refer a child with chest indrawing urgently.",
      itemRef: "rules.R3",
      urgent: true,
      rejectedAt: 300,
      ...over,
    });

    it("rejectVersion marks the latest officer-signed version rejected and keeps its signatures (AR-06, AR-10)", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      const v = await s.rejectVersion("r1", 2, rejection());
      expect(v.status).toBe("rejected");
      expect(v.rejection).toEqual(rejection());
      expect(v.signatures).toEqual([sig(2, "program_officer", "o1")]);
      expect(await s.getVersion("r1", 2)).toEqual(v);
    });

    it("a rejected version can never be signed or rejected again", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      await s.rejectVersion("r1", 2, rejection());
      await expect(s.addSignature(sig(2, "clinician", "c1"))).rejects.toBeInstanceOf(Conflict);
      await expect(s.rejectVersion("r1", 2, rejection())).rejects.toBeInstanceOf(Conflict);
    });

    it("rejectVersion refuses: no officer signature, other content, the officer themselves, locked, not latest", async () => {
      const s = await twoVersions();
      await expect(s.rejectVersion("r1", 2, rejection())).rejects.toBeInstanceOf(Conflict);
      await s.addSignature(sig(2, "program_officer", "o1"));
      await expect(s.rejectVersion("r1", 2, rejection({ modelSha: "d".repeat(64) }))).rejects.toBeInstanceOf(Conflict);
      await expect(s.rejectVersion("r1", 2, rejection({ userId: " O1" }))).rejects.toBeInstanceOf(Conflict);
      await expect(s.rejectVersion("r1", 1, rejection())).rejects.toBeInstanceOf(Conflict);
      await s.addSignature(sig(2, "clinician", "c1"));
      await expect(s.rejectVersion("r1", 2, rejection())).rejects.toBeInstanceOf(Conflict);
    });

    it("concurrent clinician signatures: exactly one succeeds", async () => {
      const s = await twoVersions();
      await s.addSignature(sig(2, "program_officer", "o1"));
      const results = await Promise.allSettled([s.addSignature(sig(2, "clinician", "c1")), s.addSignature(sig(2, "clinician", "c2"))]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await s.getVersion("r1", 2))!.signatures).toHaveLength(2);
    });
  });
}
