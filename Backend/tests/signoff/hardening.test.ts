/**
 * Red team 3 holes, fixed (DEC-020). Each block names the hole it closes.
 */
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryArtifactStore, artifactKey } from "../../src/artifacts/artifactStore.js";
import { compileLockedVersion } from "../../src/compiler/compileLocked.js";
import { ApprovalError } from "../../src/compiler/compileSnapshot.js";
import { SignRequest } from "../../src/contract/schemas.js";
import { Orchestrator } from "../../src/engine/engine.js";
import type { Model } from "../../src/logic/index.js";
import { FakeModelClient } from "../../src/model/modelClient.js";
import { CHECKS_VERSION, computeFindings, ensureFindings, settingsShaOf } from "../../src/signoff/checks.js";
import { compileSettingsKey, defaultCheckInputs, goldenCasesKey } from "../../src/signoff/checkInputs.js";
import { normaliseUserId } from "../../src/signoff/identity.js";
import { Signoff, SignoffError } from "../../src/signoff/signoff.js";
import { createChecksStep } from "../../src/steps/checks.js";
import { demoSettings } from "../compiler/helpers.js";
import { resolveForDemo } from "../helpers/resolveForDemo.js";
import { backend, bytesSha, draftV1, fullyResolved, officerFixed, openFor, seed, shaOf } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "hardening-"));
let dirs = 0;
const dir = () => join(root, `p${dirs++}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const errOf = async (p: Promise<unknown>): Promise<SignoffError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (!(e instanceof SignoffError)) throw new Error(`expected a SignoffError, got ${String(e)}`);
  return e;
};
const officer = (sha: string, userId = "officer-1") => ({ role: "program_officer" as const, userId, modelSha: sha });
const clinician = (sha: string, userId = "clinician-1") => ({ role: "clinician" as const, userId, modelSha: sha });

/** Adds version n+1 with body m the way the API does (bytes sha, role), then runs onVersionSaved. */
async function addVersion(s: Awaited<ReturnType<typeof seed>>, m: Model, authorRole?: "program_officer" | "clinician", author = "person") {
  const latest = (await s.store.listVersions("r1")).length;
  const n = latest + 1;
  const key = artifactKey("r1", "versions", `v${n}.json`);
  const text = JSON.stringify(m);
  await s.artifacts.put(key, text);
  await s.store.addVersion({ runId: "r1", n, parent: latest, author, createdAt: n, artifactKey: key, bodySha256: bytesSha(text), ...(authorRole ? { authorRole } : {}) });
  await s.signoff.onVersionSaved("r1", n);
  return n;
}
const nextOf = (m: Model): Model => {
  const c = structuredClone(m);
  c.meta.parent_version = m.meta.version;
  c.meta.version = m.meta.version + 1;
  return c;
};
async function lock(s: Awaited<ReturnType<typeof seed>>, n: number, sha: string) {
  await s.signoff.signAsAgent("r1", n, sha);
  await s.signoff.sign("r1", n, "clinician", clinician(sha));
}

describe("hole 1: only the newest locked version can be released (AR-09)", () => {
  it("refuses an older locked version once a newer one is locked; a newer unsigned draft does not block", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const m1 = fullyResolved();
    await lock(s, 1, shaOf(m1));
    const m2 = nextOf(m1);
    const n2 = await addVersion(s, m2, "program_officer");
    // v2 is an unsigned draft: v1 is still the releasable one (AR-09).
    await expect(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() })).resolves.toMatchObject({ sha: shaOf(m1) });
    await lock(s, n2, shaOf(m2));
    const e = await errOf(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() }));
    expect([e.status, e.code]).toEqual([409, "not_latest_locked"]);
    await expect(compileLockedVersion({ store: s.store, artifacts: s.artifacts, runId: "r1", n: 1, projectDir: dir(), settings: demoSettings() })).rejects.toBeInstanceOf(
      ApprovalError,
    );
    await expect(s.signoff.verifyLocked("r1", n2, { settings: demoSettings() })).resolves.toMatchObject({ sha: shaOf(m2) });
  });
});

describe("hole 2: a planted or stale findings artifact never opens a gate", () => {
  const poison = (sha: string) => ({
    runId: "r1",
    n: 1,
    modelSha: sha,
    checkedAt: 0,
    modelValid: true,
    context: { document: true, extraction: true },
    claim: "PROVEN",
    claimText: "",
    blocking: 0,
    status: "pass",
    findings: [],
    gates: { canOfficerSign: true, canClinicianSign: true, canCompile: true, summary: "ok", blockers: { officer: [], clinician: [], compile: [] } },
    views: { program_officer: [], clinician: [] },
  });

  it("the findings key carries CHECKS_VERSION and the inputs, so stricter checks are never served from an old cache", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const { key, record } = await ensureFindings(s.signoff.io, "r1", 1);
    expect(key).toContain(`/checks/${CHECKS_VERSION}/`);
    expect(key).toContain(shaOf(draftV1()));
    expect(record.checksVersion).toBe(CHECKS_VERSION);
  });

  it("a signature recomputes the checks: a planted all-clear record at the real key does not let anyone sign", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const sha = shaOf(draftV1());
    const { key } = await ensureFindings(s.signoff.io, "r1", 1);
    await s.artifacts.put(key, JSON.stringify({ ...poison(sha), checksVersion: CHECKS_VERSION }));
    const e = await errOf(s.signoff.signAsAgent("r1", 1, sha));
    expect([e.status, e.code]).toEqual([422, "blocked"]);
  });

  it("stored gate booleans are never read: the views recompute the gates from the stored findings", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const { key, record } = await ensureFindings(s.signoff.io, "r1", 1);
    const lying = { ...record, gates: { ...record.gates, canOfficerSign: true, canClinicianSign: true, canCompile: true } };
    await s.artifacts.put(key, JSON.stringify(lying));
    const st = await s.signoff.status("r1", 1);
    expect(st.gates.canOfficerSign).toBe(false);
    expect(st.gates.canCompile).toBe(false);
  });

  it("a malformed stored record is recomputed, not trusted", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const { key } = await ensureFindings(s.signoff.io, "r1", 1);
    await s.artifacts.put(key, JSON.stringify({ modelSha: shaOf(draftV1()), gates: { canOfficerSign: true } }));
    const view = await s.signoff.findingsView("r1", 1);
    expect(view.gates.canOfficerSign).toBe(false);
    expect(view.blocking).toBeGreaterThan(0);
  });

  it("the release path recomputes the checks: a planted record cannot carry blockers into a build", async () => {
    const m = draftV1();
    const sha = shaOf(m);
    const s = await seed("awaiting_officer", [m]);
    // Forge the lock in the store as well (the store is trusted for signatures until DEC-015 lands);
    // the checks still run fresh and refuse the build.
    const v = await s.store.getVersion("r1", 1);
    const stored = (s.store as unknown as { versions: Map<string, typeof v[]> }).versions.get("r1")![0]!;
    const settingsSha = settingsShaOf(demoSettings());
    Object.assign(stored, {
      status: "locked",
      signatures: [
        { runId: "r1", n: 1, modelSha: sha, role: "program_officer", userId: OFFICER_AGENT_ID, signedAt: 1, settingsSha },
        { runId: "r1", n: 1, modelSha: sha, role: "clinician", userId: "b", signedAt: 2, settingsSha },
      ],
    });
    const { key } = await ensureFindings(s.signoff.io, "r1", 1);
    await s.artifacts.put(key, JSON.stringify({ ...poison(sha), checksVersion: CHECKS_VERSION }));
    const e = await errOf(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() }));
    expect([e.status, e.code]).toEqual([422, "blocked"]);
  });
});

describe("hole 3: one person cannot sign twice under a variant of their userId", () => {
  it("normalises case, spaces, invisible characters and fullwidth letters", () => {
    for (const v of ["Alice", " alice", "alice​", "ａｌｉｃｅ", "ALICE⁠ "]) expect(normaliseUserId(v), JSON.stringify(v)).toBe("alice");
    for (const bad of ["", " ", "​", "a b", "al/ice", "x".repeat(129), "-alice"]) expect(() => normaliseUserId(bad), JSON.stringify(bad)).toThrow();
  });

  it("the request schema normalises and restricts the userId", () => {
    expect(SignRequest.parse({ role: "clinician", userId: " Dr.Alice​", modelSha: "a".repeat(64) }).userId).toBe("dr.alice");
    expect(SignRequest.safeParse({ role: "clinician", userId: "dr alice", modelSha: "a".repeat(64) }).success).toBe(false);
    expect(SignRequest.safeParse({ role: "clinician", userId: "​​", modelSha: "a".repeat(64) }).success).toBe(false);
  });

  for (const variant of ["Officer-Agent@System", " officer-agent@system", "officer-agent@system​", "ｏｆｆｉｃｅｒ-ａｇｅｎｔ@ｓｙｓｔｅｍ"]) {
    it(`officer agent then clinician ${JSON.stringify(variant)} is refused as the same person`, async () => {
      const s = await seed("awaiting_officer", [fullyResolved()]);
      const sha = shaOf(fullyResolved());
      await s.signoff.signAsAgent("r1", 1, sha);
      const e = await errOf(s.signoff.sign("r1", 1, "clinician", clinician(sha, variant)));
      expect([e.status, e.code]).toEqual([403, "separation_of_duties"]);
    });
  }

  it("a userId with nothing usable left is a 400, and the stored id is the normalised one", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await s.signoff.signAsAgent("r1", 1, sha);
    const e = await errOf(s.signoff.sign("r1", 1, "clinician", clinician(sha, "​")));
    expect([e.status, e.code]).toEqual([400, "invalid_user_id"]);
    const r = await s.signoff.sign("r1", 1, "clinician", clinician(sha, " Clinician-1 "));
    expect(r.signature.userId).toBe("clinician-1");
  });
});

describe("hole 4: open questions are checked against the earlier versions", () => {
  it("clinician questions answered in a version the program officer saved block the clinician", async () => {
    const v2 = officerFixed();
    const s = await seed("awaiting_officer", [draftV1(), v2]);
    const v3 = resolveForDemo(v2, "clinician");
    v3.meta.created_by = "demo-program_officer";
    const n3 = await addVersion(s, v3, "program_officer");
    const sha = shaOf(v3);
    await s.signoff.signAsAgent("r1", n3, sha);
    const e = await errOf(s.signoff.sign("r1", n3, "clinician", clinician(sha)));
    expect(e.code).toBe("blocked");
    const codes = (e.detail as { blockers: { code: string }[] }).blockers.map((b) => b.code);
    expect(codes.filter((c) => c === "OPEN_QUESTION_WRONG_RESOLVER")).toHaveLength(openFor(v2, "clinician"));
    expect(codes.filter((c) => c === "OPEN_QUESTION")).toHaveLength(0);
  });

  it("deleting the open questions in a new version blocks; so does marking them resolved with garbage", async () => {
    const s = await seed("awaiting_officer", [draftV1()]);
    const deleted = nextOf(draftV1());
    deleted.open_questions = [];
    const n2 = await addVersion(s, deleted, "program_officer");
    const r2 = (await ensureFindings(s.signoff.io, "r1", n2)).record;
    const all = draftV1().open_questions.length;
    expect(r2.findings.filter((f) => f.code === "OPEN_QUESTION_REMOVED")).toHaveLength(all);
    expect([r2.gates.canOfficerSign, r2.gates.canClinicianSign, r2.gates.canCompile]).toEqual([false, false, false]);

    const garbage = nextOf(draftV1());
    garbage.meta.version = 3;
    garbage.meta.parent_version = 2;
    garbage.open_questions = garbage.open_questions.map((q) => ({ ...q, status: "resolved" as const, resolution: "x" }));
    const n3 = await addVersion(s, garbage, "clinician");
    const r3 = (await ensureFindings(s.signoff.io, "r1", n3)).record;
    expect(r3.findings.filter((f) => f.code === "OPEN_QUESTION_TRIVIAL_RESOLUTION")).toHaveLength(all);
    expect(r3.gates.canClinicianSign).toBe(false);
  });

  it("the demo chain (each role answers its own questions in its own version) still reaches the lock", async () => {
    const s = await seed("awaiting_officer", [draftV1(), officerFixed(), fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await lock(s, 3, sha);
    expect((await s.store.getVersion("r1", 3))!.status).toBe("locked");
  });
});

describe("hole 5: compile settings and golden cases are inputs of the checks and of the signatures", () => {
  it("each signature records the settingsSha of the settings the checks used", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await lock(s, 1, sha);
    const v = await s.store.getVersion("r1", 1);
    expect(v!.signatures!.map((x) => x.settingsSha)).toEqual([settingsShaOf(demoSettings()), settingsShaOf(demoSettings())]);
  });

  it("a release build with other settings than the signed ones is refused; the manifest key carries the settingsSha", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await lock(s, 1, sha);
    const other = demoSettings({ taskWindowDays: 365, flowMode: "full" });
    const inputs = async () => s.inputs;
    await expect(compileLockedVersion({ store: s.store, artifacts: s.artifacts, runId: "r1", n: 1, projectDir: dir(), settings: other, inputs })).rejects.toThrow(/settings/);
    const built = await compileLockedVersion({ store: s.store, artifacts: s.artifacts, runId: "r1", n: 1, projectDir: dir(), settings: demoSettings(), inputs });
    const settingsSha = settingsShaOf(demoSettings());
    expect(built.settingsSha).toBe(settingsSha);
    expect(built.manifestKey).toBe(artifactKey("r1", "compile", sha, settingsSha, "manifest.json"));
    const audit = (await s.store.listAudit("r1")).find((a) => a.type === "compiled")!;
    expect(audit.detail).toMatchObject({ settingsSha, modelSha: sha, checksVersion: CHECKS_VERSION, goldenCases: true });
  });

  it("golden cases supplied as an input gate the clinician; a case that gets another result blocks", async () => {
    const m = fullyResolved();
    const outcome = m.outcomes[0]!.id;
    const other = m.outcomes[1]!.id;
    const answers = Object.fromEntries(m.questions.map((q) => [q.id, q.answer_type === "integer" ? (q.constraint?.min ?? 0) : false])) as Record<string, number | boolean>;
    const golden = [{ id: "g1", description: "synthetic", answers, expected_outcome: other === outcome ? outcome : other }];
    const s = await seed("awaiting_officer", [m], { inputs: { compileSettings: demoSettings(), goldenCases: golden } });
    const rec = (await computeFindings(s.signoff.io, "r1", 1)).record;
    expect(rec.context.goldenCases).toBe(true);
    expect(rec.findings.some((f) => f.check === "goldenCases")).toBe(true);
    expect(rec.checksNotRun).toEqual([]);
    expect(rec.gates.summary).not.toMatch(/Not checked/);
  });

  it("the production inputs come from the run's artifacts first, then from GOLDEN_CASES_PATH and COMPILE_SETTINGS_PATH", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "inputs-"));
    try {
      const artifacts = new MemoryArtifactStore();
      const g = join(tmp, "golden.json");
      const st = join(tmp, "settings.json");
      writeFileSync(g, JSON.stringify([{ id: "g1", description: "d", answers: { a: 1 }, expected_outcome: "x" }]));
      writeFileSync(st, JSON.stringify({ _note: "n", ...demoSettings() }));
      const fromEnv = await defaultCheckInputs(artifacts, { GOLDEN_CASES_PATH: g, COMPILE_SETTINGS_PATH: st })("r1");
      expect(fromEnv.goldenCases).toHaveLength(1);
      expect(fromEnv.compileSettings).toEqual(demoSettings());
      await artifacts.put(compileSettingsKey("r1"), JSON.stringify(demoSettings({ formTitle: "Run title" })));
      await artifacts.put(goldenCasesKey("r1"), JSON.stringify([]));
      const fromRun = await defaultCheckInputs(artifacts, { GOLDEN_CASES_PATH: g, COMPILE_SETTINGS_PATH: st })("r1");
      expect(fromRun.compileSettings!.formTitle).toBe("Run title");
      expect(fromRun.goldenCases).toEqual([]);
      // "none" switches an input off; a configured path that does not exist is an error, never a silent skip.
      expect(await defaultCheckInputs(new MemoryArtifactStore(), { GOLDEN_CASES_PATH: "none", COMPILE_SETTINGS_PATH: "none" })("r1")).toEqual({});
      await expect(defaultCheckInputs(new MemoryArtifactStore(), { GOLDEN_CASES_PATH: join(tmp, "missing.json"), COMPILE_SETTINGS_PATH: "none" })("r1")).rejects.toThrow(/missing/);
      // Defaults: the proposed golden cases and the demo settings in the repository (TODO, DEC-020).
      const defaults = await defaultCheckInputs(new MemoryArtifactStore(), {})("r1");
      expect(defaults.goldenCases!.length).toBeGreaterThan(0);
      expect(defaults.compileSettings!.formTitle).toContain("Cough");
      expect(backend).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("hole 9: the stored bytes of a locked version cannot change", () => {
  it("refuses a release when only the meta left out of modelSha was rewritten after the lock", async () => {
    const m = fullyResolved();
    const sha = shaOf(m);
    const s = await seed("awaiting_officer", [m]);
    await lock(s, 1, sha);
    const t = structuredClone(m);
    t.meta.change_note = "tampered";
    t.meta.created_by = "evil";
    await s.artifacts.put(artifactKey("r1", "versions", "v1.json"), JSON.stringify(t));
    const e = await errOf(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() }));
    expect([e.status, e.code]).toEqual([409, "body_changed"]);
  });

  it("refuses a release of a version saved without a record of its bytes", async () => {
    const m = fullyResolved();
    const sha = shaOf(m);
    const s = await seed("awaiting_officer", [m]);
    await lock(s, 1, sha);
    const stored = (s.store as unknown as { versions: Map<string, { bodySha256?: string }[]> }).versions.get("r1")![0]!;
    delete stored.bodySha256;
    const e = await errOf(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() }));
    expect(e.code).toBe("body_unsealed");
  });

  it("refuses a signature when the stored bytes no longer match the version record", async () => {
    const m = fullyResolved();
    const s = await seed("awaiting_officer", [m]);
    const t = structuredClone(m);
    t.meta.change_note = "tampered";
    await s.artifacts.put(artifactKey("r1", "versions", "v1.json"), JSON.stringify(t));
    const e = await errOf(s.signoff.signAsAgent("r1", 1, shaOf(m)));
    expect(e.code).toBe("body_changed");
  });
});

describe("hole 10: a signer is told plainly which checks did not run", () => {
  it("without golden cases the record, the summary and the sign result say the test-case check did not run", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()], { inputs: { compileSettings: demoSettings() } });
    const sha = shaOf(fullyResolved());
    const rec = await s.signoff.findingsRecord("r1", 1);
    expect(rec.checksNotRun.join(" ")).toMatch(/test cases/);
    expect(rec.gates.summary).toMatch(/Not checked: .*test cases/);
    const view = await s.signoff.findingsView("r1", 1, "clinician");
    expect(view.checksNotRun.join(" ")).toMatch(/test cases/);
    // The officer may still sign; the result names what was not checked.
    const res = await s.signoff.signAsAgent("r1", 1, sha).catch((e: SignoffError) => e);
    const notRun = res instanceof SignoffError ? (res.detail as { checksNotRun: string[] }).checksNotRun : res.checksNotRun;
    expect(notRun.join(" ")).toMatch(/test cases/);
  });

  it("without settings the form-readiness check is named as not run", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()], { inputs: {} });
    const rec = await s.signoff.findingsRecord("r1", 1);
    expect(rec.checksNotRun.join(" ")).toMatch(/form settings/);
  });
});

describe("hole 7: a run never gets stuck between versions", () => {
  it("a run left in awaiting_clinician while its newest version has no signature heals back to awaiting_officer", async () => {
    const s = await seed("awaiting_officer", [officerFixed()]);
    await s.signoff.signAsAgent("r1", 1, shaOf(officerFixed()));
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_clinician");
    // A save while another worker holds the lease: the version is added, the run state is not moved.
    await s.store.acquireLease("r1", "other-worker", 600_000, s.clock.ms);
    const m2 = resolveForDemo(officerFixed(), "clinician");
    const n2 = await addVersion(s, m2, "clinician", "clinician-1");
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_clinician");
    await s.store.releaseLease("r1", "other-worker");
    const st = await s.signoff.status("r1", n2);
    expect(st.runState).toBe("awaiting_officer");
    const r = await s.signoff.signAsAgent("r1", n2, shaOf(m2));
    expect(r.runState).toBe("awaiting_clinician");
  });

  it("a failed check after a save leaves the run failed at the checks step, and resume retries it", async () => {
    const s = await seed("awaiting_officer", [officerFixed()]);
    let fail = true;
    const flaky = new Signoff({
      store: s.store,
      artifacts: s.artifacts,
      now: () => s.clock.ms++,
      inputs: async () => {
        if (fail) throw new Error("settings store down");
        return { compileSettings: demoSettings() };
      },
    });
    const m2 = resolveForDemo(officerFixed(), "clinician");
    const key = artifactKey("r1", "versions", "v2.json");
    await s.artifacts.put(key, JSON.stringify(m2));
    await s.store.addVersion({ runId: "r1", n: 2, parent: 1, author: "c", createdAt: 2, artifactKey: key, bodySha256: bytesSha(JSON.stringify(m2)), authorRole: "clinician" });
    await expect(flaky.onVersionSaved("r1", 2)).rejects.toThrow(/settings store down/);
    expect(await s.store.getRun("r1")).toMatchObject({ state: "failed", currentStep: "checks" });
    fail = false;
    const orchestrator = new Orchestrator({
      store: s.store,
      artifacts: s.artifacts,
      model: new FakeModelClient([]),
      steps: [createChecksStep({ inputs: async () => ({ compileSettings: demoSettings() }) })],
      finalState: "awaiting_officer",
      owner: "t",
      leaseMs: 60_000,
      runnerOpts: { maxAttempts: 1, backoffMs: () => 0, sleep: async () => {}, prices: {} },
      now: () => s.clock.ms++,
    });
    await orchestrator.resume("r1");
    expect((await s.store.getRun("r1"))!.state).toBe("awaiting_officer");
  });
});

describe("hole 8: the clinician can reject a version with a comment (AR-06, RR-02)", () => {
  const reject = (sha: string, over: Record<string, unknown> = {}) => ({
    role: "clinician" as const,
    userId: "clinician-1",
    modelSha: sha,
    comment: "R3 must refer a child with chest indrawing urgently, not treat at home.",
    itemRef: "rules.R3",
    urgent: true,
    ...over,
  });

  it("rejects after the officer signed: the version is rejected, kept, and the run goes back to the officer", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await s.signoff.signAsAgent("r1", 1, sha);
    const r = await s.signoff.reject("r1", 1, reject(sha));
    expect(r).toMatchObject({ status: "rejected", runState: "awaiting_officer" });
    const v = await s.store.getVersion("r1", 1);
    expect(v!.status).toBe("rejected");
    expect(v!.rejection).toMatchObject({ comment: expect.stringContaining("R3"), itemRef: "rules.R3", urgent: true, userId: "clinician-1" });
    expect(v!.signatures).toHaveLength(1);
    const comments = await s.store.listComments("r1", 1);
    expect(comments).toEqual([expect.objectContaining({ itemRef: "rules.R3", author: "clinician-1" })]);
    expect((await s.store.listAudit("r1")).some((a) => a.type === "version_rejected")).toBe(true);
    expect((await s.signoff.status("r1", 1)).status).toBe("rejected");
  });

  it("a rejected version can never be signed or built; the officer's fix is a new version that starts over", async () => {
    const m = fullyResolved();
    const s = await seed("awaiting_officer", [m]);
    const sha = shaOf(m);
    await s.signoff.signAsAgent("r1", 1, sha);
    await s.signoff.reject("r1", 1, reject(sha));
    for (const role of ["program_officer", "clinician"] as const) {
      const e = await errOf(s.signoff.sign("r1", 1, role, role === "clinician" ? clinician(sha) : officer(sha)).catch((x) => (role === "program_officer" ? s.signoff.signAsAgent("r1", 1, sha) : Promise.reject(x))));
      expect([e.status, e.code]).toEqual([409, "rejected"]);
    }
    const e = await errOf(s.signoff.verifyLocked("r1", 1, { settings: demoSettings() }));
    expect(e.code).toBe("not_locked");
    const fix = nextOf(m);
    const n2 = await addVersion(s, fix, "program_officer");
    expect((await s.signoff.status("r1", n2)).signatures).toEqual([]);
    await lock(s, n2, shaOf(fix));
    expect((await s.store.getVersion("r1", 1))!.status).toBe("rejected");
  });

  it("refuses: a comment that says nothing, before the officer signed, by the officer, for other content", async () => {
    const s = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    expect((await errOf(s.signoff.reject("r1", 1, reject(sha)))).code).toBe("officer_signature_required");
    await s.signoff.signAsAgent("r1", 1, sha);
    expect((await errOf(s.signoff.reject("r1", 1, reject(sha, { comment: "no" })))).status).toBe(422);
    expect((await errOf(s.signoff.reject("r1", 1, reject(sha, { userId: " Officer-Agent@System" })))).code).toBe("separation_of_duties");
    expect((await errOf(s.signoff.reject("r1", 1, reject("0".repeat(64))))).code).toBe("sha_mismatch");
  });
});
