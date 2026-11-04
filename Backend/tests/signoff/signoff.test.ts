import { describe, expect, it } from "vitest";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import { artifactKey } from "../../src/artifacts/artifactStore.js";
import { findingsKey, inputsShaOf } from "../../src/signoff/checks.js";
import { demoSettings } from "../compiler/helpers.js";
import { SignoffError } from "../../src/signoff/signoff.js";
import { draftV1, fullyResolved, officerFixed, openFor, seed, shaOf, testInputs } from "./helpers.js";

const IN = inputsShaOf(testInputs());
const build = { settings: demoSettings() };

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

describe("findings (BR-11: checks before anyone signs)", () => {
  it("computes the findings once per modelSha and stores them with a view per audience", async () => {
    const { signoff, artifacts } = await seed("awaiting_officer", [draftV1()]);
    const sha = shaOf(draftV1());
    const rec = await signoff.findingsRecord("r1", 1);
    expect(rec.modelSha).toBe(sha);
    expect(rec.context).toEqual({ document: true, extraction: true, goldenCases: true, compileSettings: true, history: 0 });
    expect(rec.claim).toBe("PROVEN");
    expect(rec.gates.canOfficerSign).toBe(false);
    expect(await artifacts.exists(findingsKey("r1", sha, IN))).toBe(true);
    expect(rec.views.program_officer.length).toBeGreaterThan(0);
    expect(rec.views.clinician.length).toBeGreaterThan(0);
  });

  it("filters by audience: each role sees only what is addressed to it, its own items first", async () => {
    const { signoff } = await seed("awaiting_officer", [draftV1()]);
    const view = await signoff.findingsView("r1", 1, "clinician");
    const all = view.groups.flatMap((g) => g.findings);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((f) => f.audience.includes("clinician"))).toBe(true);
    const blocking = view.groups.find((g) => g.severity === "blocking")!.findings;
    expect(blocking.every((f) => f.decidedBy === "clinician")).toBe(true);
    expect(blocking.filter((f) => f.code === "OPEN_QUESTION")).toHaveLength(openFor(draftV1(), "clinician"));
  });

  it("refuses an unknown version", async () => {
    const { signoff } = await seed("awaiting_officer", [draftV1()]);
    expect((await errOf(signoff.findingsRecord("r1", 9))).status).toBe(404);
  });
});

describe("sign: gates (BR-11, AR-03)", () => {
  it("refuses the officer while officer blockers remain, and records nothing", async () => {
    const { signoff, store } = await seed("awaiting_officer", [draftV1()]);
    const e = await errOf(signoff.signAsAgent("r1", 1, shaOf(draftV1())));
    expect(e.status).toBe(422);
    expect(e.code).toBe("blocked");
    const blockers = (e.detail as { blockers: { code: string }[] }).blockers;
    expect(blockers.filter((b) => b.code === "OPEN_QUESTION")).toHaveLength(openFor(draftV1(), "program_officer"));
    expect((await store.getVersion("r1", 1))!.signatures ?? []).toEqual([]);
  });

  it("lets the officer sign once the officer blockers are settled, even with clinician questions open", async () => {
    const { signoff, store } = await seed("awaiting_officer", [draftV1(), officerFixed()]);
    const res = await signoff.signAsAgent("r1", 2, shaOf(officerFixed()));
    expect(res.status).toBe("awaiting_clinician");
    expect(res.runState).toBe("awaiting_clinician");
    expect((await store.getRun("r1"))!.state).toBe("awaiting_clinician");
  });

  it("refuses the clinician while clinical blockers remain (open questions routed to the clinician)", async () => {
    const { signoff } = await seed("awaiting_officer", [draftV1(), officerFixed()]);
    const sha = shaOf(officerFixed());
    await signoff.signAsAgent("r1", 2, sha);
    const e = await errOf(signoff.sign("r1", 2, "clinician", clinician(sha)));
    expect(e.status).toBe(422);
    const codes = (e.detail as { blockers: { code: string }[] }).blockers.map((b) => b.code);
    expect(codes.filter((c) => c === "OPEN_QUESTION")).toHaveLength(openFor(officerFixed(), "clinician"));
  });
});

describe("sign: order, separation of duties and lock (AR-03, AR-05, BRD section 4)", () => {
  it("officer then clinician locks the version and the run", async () => {
    const { signoff, store } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    const res = await signoff.sign("r1", 1, "clinician", clinician(sha));
    expect(res.status).toBe("locked");
    expect((await store.getRun("r1"))!.state).toBe("locked");
    const v = (await store.getVersion("r1", 1))!;
    expect(v.status).toBe("locked");
    expect(v.signatures!.map((s) => [s.role, s.userId, s.modelSha])).toEqual([
      ["program_officer", OFFICER_AGENT_ID, sha],
      ["clinician", "clinician-1", sha],
    ]);
    const audit = (await store.listAudit("r1")).map((a) => a.type);
    expect(audit.filter((t) => t === "signature")).toHaveLength(2);
    expect(audit).toContain("version_locked");
  });

  it("refuses the clinician before the officer (409)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const e = await errOf(signoff.sign("r1", 1, "clinician", clinician(shaOf(fullyResolved()))));
    expect([e.status, e.code]).toEqual([409, "officer_signature_required"]);
  });

  it("refuses the same person signing as officer and clinician (403)", async () => {
    const { signoff, store } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    const e = await errOf(signoff.sign("r1", 1, "clinician", clinician(sha, OFFICER_AGENT_ID)));
    expect([e.status, e.code]).toEqual([403, "separation_of_duties"]);
    expect((await store.getVersion("r1", 1))!.status ?? "draft").toBe("draft");
  });

  it("refuses a person at the program officer endpoint (403 agent_only) and records nothing", async () => {
    const { signoff, store } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    const e = await errOf(signoff.sign("r1", 1, "program_officer", officer(sha)));
    expect([e.status, e.code]).toEqual([403, "agent_only"]);
    expect((await store.getVersion("r1", 1))!.signatures ?? []).toEqual([]);
  });

  it("refuses a second officer signature (409)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    const e = await errOf(signoff.signAsAgent("r1", 1, sha));
    expect([e.status, e.code]).toEqual([409, "already_signed"]);
  });

  it("refuses any signature on a locked version (409)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    await signoff.sign("r1", 1, "clinician", clinician(sha));
    const e = await errOf(signoff.sign("r1", 1, "clinician", clinician(sha, "clinician-2")));
    expect([e.status, e.code]).toEqual([409, "locked"]);
  });

  it("refuses a role in the body that does not match the endpoint (403)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const e = await errOf(signoff.sign("r1", 1, "clinician", officer(shaOf(fullyResolved()))));
    expect([e.status, e.code]).toEqual([403, "role_mismatch"]);
  });

  it("refuses an endpoint role that does not exist (404)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const e = await errOf(signoff.sign("r1", 1, "it", officer(shaOf(fullyResolved()))));
    expect([e.status, e.code]).toEqual([404, "unknown_role"]);
  });

  it("refuses to sign while the checks of the version are still running (run in checking)", async () => {
    const { signoff } = await seed("checking", [fullyResolved()]);
    const e = await errOf(signoff.signAsAgent("r1", 1, shaOf(fullyResolved())));
    expect([e.status, e.code]).toEqual([409, "wrong_state"]);
  });
});

describe("sign: bound to the exact modelSha (AR-07, AR-04)", () => {
  it("refuses a signature for content the signer did not see (sha mismatch, 409)", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const e = await errOf(signoff.signAsAgent("r1", 1, shaOf(draftV1())));
    expect([e.status, e.code]).toEqual([409, "sha_mismatch"]);
  });

  it("an officer signature no longer counts when the body changed under it (and the bytes check refuses it outright)", async () => {
    const { signoff, artifacts } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    // Tampering with the stored body (never done by the app: edits are new versions) changes the sha.
    const tampered = fullyResolved();
    tampered.questions[0]!.label = "Changed after the officer signed";
    await artifacts.put(artifactKey("r1", "versions", "v1.json"), JSON.stringify(tampered));
    const st = await signoff.status("r1", 1);
    expect(st.status).toBe("awaiting_officer");
    expect(st.validSignatures).toEqual([]);
    const e = await errOf(signoff.sign("r1", 1, "clinician", clinician(shaOf(tampered))));
    expect([e.status, e.code]).toEqual([409, "body_changed"]);
  });

  it("a new version starts over: the old version cannot collect more signatures (superseded)", async () => {
    const { signoff, store, artifacts } = await seed("awaiting_officer", [officerFixed()]);
    const sha1 = shaOf(officerFixed());
    await signoff.signAsAgent("r1", 1, sha1);
    const v2 = fullyResolved();
    await artifacts.put(artifactKey("r1", "versions", "v2.json"), JSON.stringify(v2));
    await store.addVersion({ runId: "r1", n: 2, parent: 1, author: "clinician-1", createdAt: 5, artifactKey: artifactKey("r1", "versions", "v2.json") });
    await signoff.onVersionSaved("r1", 2);
    expect((await store.getRun("r1"))!.state).toBe("awaiting_officer");
    const e = await errOf(signoff.sign("r1", 1, "clinician", clinician(sha1)));
    expect([e.status, e.code]).toEqual([409, "superseded"]);
    const st2 = await signoff.status("r1", 2);
    expect(st2.status).toBe("awaiting_officer");
    expect(st2.signatures).toEqual([]);
    expect((await signoff.status("r1", 1)).status).toBe("superseded");
  });

  it("edit after lock: a new version with zero signatures; the locked one stays locked and releasable (AR-05, AR-09)", async () => {
    const { signoff, store, artifacts } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    await signoff.sign("r1", 1, "clinician", clinician(sha));
    const edited = fullyResolved();
    edited.meta.version = 2;
    edited.meta.parent_version = 1;
    await artifacts.put(artifactKey("r1", "versions", "v2.json"), JSON.stringify(edited));
    await store.addVersion({ runId: "r1", n: 2, parent: 1, author: "officer-1", createdAt: 9, artifactKey: artifactKey("r1", "versions", "v2.json") });
    await signoff.onVersionSaved("r1", 2);
    expect((await store.getRun("r1"))!.state).toBe("awaiting_officer");
    expect((await store.getVersion("r1", 1))!.status).toBe("locked");
    const st1 = await signoff.status("r1", 1);
    expect(st1.status).toBe("locked");
    const st2 = await signoff.status("r1", 2);
    expect(st2.status).toBe("awaiting_officer");
    expect(st2.latestLocked).toBe(1);
    expect(shaOf(edited)).not.toBe(sha);
  });
});

describe("onVersionSaved (checks on every save, GR-03)", () => {
  it("moves the run through checking to awaiting_officer and stores the findings for the new sha", async () => {
    const { signoff, store, artifacts } = await seed("awaiting_clinician", [draftV1(), officerFixed()]);
    await signoff.onVersionSaved("r1", 2);
    expect((await store.getRun("r1"))!.state).toBe("awaiting_officer");
    expect(await artifacts.exists(findingsKey("r1", shaOf(officerFixed()), IN))).toBe(true);
    const states = (await store.listAudit("r1")).filter((a) => a.type === "run_state").map((a) => a.detail);
    expect(states).toEqual([
      { from: "awaiting_clinician", to: "checking" },
      { from: "checking", to: "awaiting_officer" },
    ]);
  });

  it("leaves a run that is not in a review state alone, but still stores the findings", async () => {
    const { signoff, store, artifacts } = await seed("extracting", [draftV1()]);
    await signoff.onVersionSaved("r1", 1);
    expect((await store.getRun("r1"))!.state).toBe("extracting");
    expect(await artifacts.exists(findingsKey("r1", shaOf(draftV1()), IN))).toBe(true);
  });

  it("does not take a run whose lease another worker holds", async () => {
    const { signoff, store } = await seed("awaiting_officer", [draftV1()]);
    await store.acquireLease("r1", "engine", 1_000_000, 0);
    await signoff.onVersionSaved("r1", 1);
    expect((await store.getRun("r1"))!.state).toBe("awaiting_officer");
  });
});

describe("verifyLocked (AR-08)", () => {
  it("refuses an unsigned version", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const e = await errOf(signoff.verifyLocked("r1", 1, build));
    expect([e.status, e.code]).toEqual([409, "not_locked"]);
  });

  it("refuses a version with only the officer signature", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    await signoff.signAsAgent("r1", 1, shaOf(fullyResolved()));
    expect((await errOf(signoff.verifyLocked("r1", 1, build))).code).toBe("not_locked");
  });

  it("returns the model, sha and signatures of a locked version", async () => {
    const { signoff } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    await signoff.sign("r1", 1, "clinician", clinician(sha));
    const ok = await signoff.verifyLocked("r1", 1, build);
    expect(ok.sha).toBe(sha);
    expect(ok.version.signatures).toHaveLength(2);
  });

  it("refuses a locked version whose stored body no longer matches the signatures", async () => {
    const { signoff, artifacts } = await seed("awaiting_officer", [fullyResolved()]);
    const sha = shaOf(fullyResolved());
    await signoff.signAsAgent("r1", 1, sha);
    await signoff.sign("r1", 1, "clinician", clinician(sha));
    const tampered = fullyResolved();
    tampered.outcomes[0]!.title = "Changed after locking";
    await artifacts.put(artifactKey("r1", "versions", "v1.json"), JSON.stringify(tampered));
    const e = await errOf(signoff.verifyLocked("r1", 1, build));
    expect(e.code).toBe("not_locked");
    expect(e.message).toMatch(/different content/);
  });
});
