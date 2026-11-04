import { describe, expect, it } from "vitest";
import { FakeModelClient } from "../../../src/model/modelClient.js";
import { ModelOutputError } from "../../../src/model/modelClient.js";
import { InProcessDispatcher } from "../../../src/revision/dispatch.js";
import type { RevisionDispatcher } from "../../../src/revision/dispatch.js";
import { RevisionError, RevisionService, STALE_ERROR } from "../../../src/revision/service.js";
import { APPLYING_STALE_MS, revisionKey } from "../../../src/revision/types.js";
import { draftV1 } from "../../signoff/helpers.js";
import { seed } from "../../signoff/helpers.js";
import { FakeEngine, INSTRUCTION_RAW, PROPOSAL_RAW } from "./fakeEngine.js";

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, modelId: "m1" });
const ok1 = { raw: INSTRUCTION_RAW, usage: usage(100, 20) };
const ok2 = { raw: PROPOSAL_RAW, usage: usage(300, 40) };
const officer = { role: "program_officer" as const, userId: "alice" };
const clinician = { role: "clinician" as const, userId: "bob" };

async function setup(responses: (typeof ok1 | Error)[], opts: { onSaved?: (r: string, n: number) => Promise<void>; dispatcher?: RevisionDispatcher } = {}) {
  const s = await seed("awaiting_officer", [draftV1()]);
  const model = new FakeModelClient(responses);
  const engine = new FakeEngine();
  const saved: [string, number][] = [];
  const warnings: object[] = [];
  const inProcess = new InProcessDispatcher((j) => service.runApply(j.runId, j.revisionId));
  const service: RevisionService = new RevisionService({
    dispatcher: opts.dispatcher ?? inProcess,
    logger: { warn: (d) => warnings.push(d), error: () => {} },
    leaseRetries: 2,
    leaseRetryMs: 1,
    store: s.store,
    artifacts: s.artifacts,
    model,
    engine,
    modelId: "m1",
    prompts: { fill: "FILL PROMPT", instruction: "INSTR PROMPT", revise: "REVISE ADDENDUM" },
    now: () => s.clock.ms++,
    onVersionSaved: opts.onSaved ?? (async (r, n) => { saved.push([r, n]); }),
    prices: { m1: { inPerMTok: 1, outPerMTok: 2 } },
  });
  const comment = (itemRef = "rules.R1", text = "Threshold looks wrong") => s.store.addComment({ runId: "r1", n: 1, itemRef, author: "alice", text, createdAt: 5 });
  /** Confirm, wait for the background work, return the stored revision. */
  const confirm = async (revId: string, actor: { role: "program_officer" | "clinician"; userId: string; instruction?: string }) => {
    await service.confirmRevision("r1", revId, actor);
    await inProcess.drain();
    return service.getRevision("r1", revId);
  };
  return { ...s, model, engine, service, saved, comment, inProcess, confirm, warnings };
}

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof RevisionError ? `${e.status}:${e.code}` : String(e); }
  return "ok";
};

describe("requestRevision (step 1)", () => {
  it("calls the model once, stores an instruction_ready revision, audits without comment text", async () => {
    const t = await setup([ok1]);
    await t.comment("rules.R1", "SECRET-COMMENT-TEXT");
    const rev = await t.service.requestRevision("r1", 1, officer);
    expect(t.model.calls).toHaveLength(1);
    expect(t.model.calls[0]!.system).toBe("SYSTEM-1");
    expect(t.engine.instructionArgs[0]!.prompt).toBe("INSTR PROMPT");
    expect(rev).toMatchObject({ runId: "r1", fromVersion: 1, status: "instruction_ready", requestedBy: officer });
    expect(rev.comments).toEqual([expect.objectContaining({ itemRef: "rules.R1", source: "comment", text: "SECRET-COMMENT-TEXT" })]);
    expect(rev.usage).toHaveLength(1);
    expect(rev.usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, modelId: "m1", costUsd: (100 + 40) / 1e6 });
    expect(await t.artifacts.exists(revisionKey("r1", rev.id))).toBe(true);
    const audit = (await t.store.listAudit("r1")).filter((e) => e.type === "revision_requested");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("SECRET-COMMENT-TEXT");
    expect(audit[0]!.detail).toMatchObject({ revisionId: rev.id, n: 1, comments: 1 });
  });

  it("422 no_comments when there are none, or the itemRefs match none", async () => {
    const t = await setup([ok1]);
    expect(await code(t.service.requestRevision("r1", 1, officer))).toBe("422:no_comments");
    await t.comment("rules.R1");
    expect(await code(t.service.requestRevision("r1", 1, { ...officer, itemRefs: ["rules.R9"] }))).toBe("422:no_comments");
    expect(t.model.calls).toHaveLength(0);
  });

  it("filters by itemRefs and includes the rejection comment as source rejection", async () => {
    const t = await setup([ok1]);
    await t.comment("rules.R1");
    await t.comment("rules.R2");
    const v = (await t.store.getVersion("r1", 1))!;
    // A rejection needs an officer signature first; write the row state directly through the store contract.
    const withRejection = { ...v, rejection: { role: "clinician" as const, userId: "bob", modelSha: "x", comment: "Reject text here please", urgent: false, rejectedAt: 9 } };
    t.store.listVersions = async () => [withRejection];
    const rev = await t.service.requestRevision("r1", 1, { ...officer, itemRefs: ["rules.R2", "version"] });
    expect(rev.comments.map((c) => [c.itemRef, c.source])).toEqual([["rules.R2", "comment"], ["version", "rejection"]]);
  });

  it("409 not_latest and 404 for a missing version, 409 locked", async () => {
    const t = await setup([ok1]);
    await t.comment();
    expect(await code(t.service.requestRevision("r1", 7, officer))).toBe("404:not_found");
    expect(await code(t.service.requestRevision("nope", 1, officer))).toBe("404:not_found");
    await t.store.addVersion({ runId: "r1", n: 2, parent: 1, author: "x", createdAt: 7, artifactKey: (await t.store.getVersion("r1", 1))!.artifactKey });
    expect(await code(t.service.requestRevision("r1", 1, officer))).toBe("409:not_latest");
  });

  it("409 locked for a locked latest version", async () => {
    const t = await setup([ok1]);
    await t.comment();
    const orig = t.store.listVersions.bind(t.store);
    t.store.listVersions = async (r) => (await orig(r)).map((v) => ({ ...v, status: "locked" as const }));
    expect(await code(t.service.requestRevision("r1", 1, officer))).toBe("409:locked");
  });

  it("invalid step 1 output: 502 with the id, a stored failed revision, its usage counted", async () => {
    const t = await setup([new ModelOutputError("bad SECRET-RAW", "raw", undefined, usage(70, 7))]);
    await t.comment();
    let err: unknown;
    try { await t.service.requestRevision("r1", 1, officer); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RevisionError);
    const e = err as RevisionError;
    expect(`${e.status}:${e.code}`).toBe("502:model_output_invalid");
    const list = await t.service.listRevisions("r1");
    expect(list).toHaveLength(1);
    expect(e.detail).toEqual({ revisionId: list[0]!.id });
    expect(list[0]).toMatchObject({ status: "failed", instruction: "" });
    expect(list[0]!.usage).toHaveLength(1);
    expect(JSON.stringify(list[0])).not.toContain("SECRET-RAW");
    expect(await t.service.usageRows("r1")).toEqual([expect.objectContaining({ process: "revision", versionId: "1", inputTokens: 70, outputTokens: 7 })]);
    // an empty instruction cannot be confirmed without a new one
    expect(await code(t.service.confirmRevision("r1", list[0]!.id, officer))).toBe("422:no_instruction");
  });

  it("any other model error in step 1: 502 model_unavailable, stored failed, no raw SDK text", async () => {
    const t = await setup([new Error("ThrottlingException: secret endpoint arn:aws:xyz")]);
    await t.comment();
    let err: RevisionError | undefined;
    try { await t.service.requestRevision("r1", 1, officer); } catch (e) { err = e as RevisionError; }
    expect(`${err!.status}:${err!.code}`).toBe("502:model_unavailable");
    const list = await t.service.listRevisions("r1");
    expect(list[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify([list, err!.message])).not.toContain("arn:aws");
    expect(list[0]!.error).toContain("Error");
  });

  it("drops notes on items nobody commented on", async () => {
    const raw = JSON.stringify({ instruction: "Raise the fast breathing threshold.", notes: [{ itemRef: "rules.R1", understood: "a", feasible: "extraction_supported" }, { itemRef: "rules.R9", understood: "b", feasible: "needs_human" }] });
    const t = await setup([{ raw, usage: usage(1, 1) }]);
    await t.comment();
    expect((await t.service.requestRevision("r1", 1, officer)).notes.map((n) => n.itemRef)).toEqual(["rules.R1"]);
  });
});

describe("confirmRevision (step 2)", () => {
  it("happy path: new version by ai, no signatures, parent set, checks run, audit, usage", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const done = await t.confirm(rev.id, clinician);
    expect(done).toMatchObject({ status: "applied", toVersion: 2, confirmedBy: clinician, confirmedInstruction: rev.instruction });
    const v2 = (await t.store.getVersion("r1", 2))!;
    expect(v2).toMatchObject({ n: 2, parent: 1, author: "ai" });
    expect(v2.authorRole).toBeUndefined();
    expect(v2.signatures ?? []).toEqual([]);
    expect(v2.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.saved).toEqual([["r1", 2]]);
    expect(done.usage).toHaveLength(2);
    expect(done.usage[1]).toMatchObject({ inputTokens: 300, outputTokens: 40, modelId: "m1" });
    expect(done.usage[1]!.costUsd).toBeCloseTo((300 + 80) / 1e6);
    expect(t.model.calls).toHaveLength(2);
    expect(t.model.calls[1]!.system).toBe("FILL PROMPT\nREVISE ADDENDUM");
    expect(t.engine.applyArgs[0]!.revision).toMatchObject({ id: rev.id, fromVersion: 1, instruction: rev.instruction });
    const types = (await t.store.listAudit("r1")).map((e) => e.type);
    expect(types).toEqual(["revision_requested", "revision_usage", "revision_confirmed", "revision_usage", "revision_applied"]);
    expect(await t.service.getRevision("r1", rev.id)).toEqual(done);
    expect((await t.store.getRun("r1"))!.lease).toBeUndefined();
  });

  it("passes an edited instruction to the engine and stores it", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const done = await t.confirm(rev.id, { ...clinician, instruction: "My own edited instruction text" });
    expect(t.engine.proposalArgs[0]!.instruction).toBe("My own edited instruction text");
    expect(t.engine.applyArgs[0]!.revision.instruction).toBe("My own edited instruction text");
    expect(done.confirmedInstruction).toBe("My own edited instruction text");
    expect(done.instruction).toBe(rev.instruction);
    expect(t.engine.proposalArgs[0]!.targets).toEqual({ items: ["rules.R1"] });
  });

  it("no_change saves no version and is final", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    t.engine.produce = false;
    const rev = await t.service.requestRevision("r1", 1, officer);
    const done = await t.confirm(rev.id, officer);
    expect(done).toMatchObject({ status: "no_change", questionsAdded: ["Q-new"] });
    expect(await t.store.getVersion("r1", 2)).toBeUndefined();
    expect(t.saved).toEqual([]);
    expect((await t.store.listAudit("r1")).map((e) => e.type)).toContain("revision_no_change");
    expect(await code(t.service.confirmRevision("r1", rev.id, officer))).toBe("409:already_final");
  });

  it("a model output error marks failed, saves nothing, records paid usage, and can be confirmed again", async () => {
    const t = await setup([ok1, new ModelOutputError("not json", "raw", undefined, usage(50, 5)), ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const failed = await t.confirm(rev.id, officer);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("ModelOutputError");
    expect(failed.error).not.toContain("not json");
    expect(failed.usage).toHaveLength(2);
    expect(await t.store.getVersion("r1", 2)).toBeUndefined();
    expect((await t.store.listAudit("r1")).map((e) => e.type)).toContain("revision_failed");
    const again = await t.confirm(rev.id, officer);
    expect(again).toMatchObject({ status: "applied", toVersion: 2 });
    expect(again.error).toBeUndefined();
  });

  it("an engine exception is a failed revision, not a crash", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    t.engine.throwInApply = true;
    const rev = await t.service.requestRevision("r1", 1, officer);
    const failed = await t.confirm(rev.id, officer);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toContain("could not be applied");
    expect(failed.error).not.toContain("apply exploded");
  });

  it("a model from the engine that is invalid or has wrong meta is a failed revision and saves nothing", async () => {
    const bad: ((m: Record<string, any>) => void)[] = [
      (m) => { delete m.rules; },
      (m) => { m.meta.version = 5; },
      (m) => { m.meta.parent_version = 0; },
    ];
    for (const mutate of bad) {
      const t = await setup([ok1, ok2]);
      await t.comment();
      const orig = t.engine.applyProposal.bind(t.engine);
      t.engine.applyProposal = (a) => {
        const r = orig(a);
        mutate(r.model as never);
        return r;
      };
      const rev = await t.service.requestRevision("r1", 1, officer);
      const failed = await t.confirm(rev.id, officer);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/revised model/);
      expect(failed.toVersion).toBeUndefined();
      expect(await t.store.getVersion("r1", 2)).toBeUndefined();
      expect(t.saved).toEqual([]);
    }
  });

  it("409 superseded when a newer version exists", async () => {
    const t = await setup([ok1]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    await t.store.addVersion({ runId: "r1", n: 2, parent: 1, author: "x", createdAt: 7, artifactKey: (await t.store.getVersion("r1", 1))!.artifactKey });
    expect(await code(t.service.confirmRevision("r1", rev.id, officer))).toBe("409:superseded");
  });

  it("two simultaneous confirms: one is accepted, the loser gets 409; one version", async () => {
    const t = await setup([ok1, ok2, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const results = await Promise.all([code(t.service.confirmRevision("r1", rev.id, officer)), code(t.service.confirmRevision("r1", rev.id, clinician))]);
    await t.inProcess.drain();
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.startsWith("409:"))).toHaveLength(1);
    expect((await t.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
    expect(t.saved).toEqual([["r1", 2]]);
  });

  it("confirm returns at once with status applying and a dispatched job; the work has not run yet", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const res = await t.service.confirmRevision("r1", rev.id, clinician);
    expect(res).toMatchObject({ status: "applying", confirmedBy: clinician });
    expect(res.applyingSince).toBeTypeOf("number");
    expect(t.model.calls).toHaveLength(1);
    await t.inProcess.drain();
    expect(t.model.calls).toHaveLength(2);
    expect((await t.store.listAudit("r1")).map((e) => e.type)).toContain("revision_confirmed");
  });

  it("a second runApply for the same revision does nothing: one version, one model call", async () => {
    const t = await setup([ok1, ok2, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    await t.confirm(rev.id, officer);
    await t.service.runApply("r1", rev.id);
    await Promise.all([t.service.runApply("r1", rev.id), t.service.runApply("r1", rev.id)]);
    expect(t.model.calls).toHaveLength(2);
    expect((await t.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
    expect(t.saved).toEqual([["r1", 2]]);
  });

  it("two concurrent runApply on an applying revision run the work once", async () => {
    const t = await setup([ok1, ok2, ok2], { dispatcher: { dispatch: async () => {} } });
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    await t.service.confirmRevision("r1", rev.id, officer);
    await Promise.all([t.service.runApply("r1", rev.id), t.service.runApply("r1", rev.id)]);
    expect(t.model.calls).toHaveLength(2);
    expect((await t.store.listVersions("r1")).map((v) => v.n)).toEqual([1, 2]);
    expect((await t.service.getRevision("r1", rev.id)).status).toBe("applied");
  });

  it("a Conflict from addVersion fails the revision with a clear reason and keeps the paid usage", async () => {
    const t = await setup([ok1, ok2]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const orig = t.store.addVersion.bind(t.store);
    t.store.addVersion = async (v) => {
      const { Conflict } = await import("../../../src/store/store.js");
      throw new Conflict("taken");
    };
    void orig;
    const failed = await t.confirm(rev.id, officer);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Another version was saved");
    expect(failed.usage).toHaveLength(2);
    const rows = await t.service.usageRows("r1");
    expect(rows.map((r) => r.inputTokens)).toEqual([100, 300]);
  });

  it("dispatch failure: revision back to failed, 502 dispatch_failed, no raw error text", async () => {
    const t = await setup([ok1], { dispatcher: { dispatch: async () => { throw new Error("AccessDenied: arn:aws:lambda:secret"); } } });
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    expect(await code(t.service.confirmRevision("r1", rev.id, officer))).toBe("502:dispatch_failed");
    const after = await t.service.getRevision("r1", rev.id);
    expect(after.status).toBe("failed");
    expect(JSON.stringify(after)).not.toContain("arn:aws");
  });

  it("stale applying is reported failed on every read and can be confirmed again", async () => {
    const t = await setup([ok1, ok2], { dispatcher: { dispatch: async () => {} } });
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const applying = await t.service.confirmRevision("r1", rev.id, officer);
    expect((await t.service.getRevision("r1", rev.id)).status).toBe("applying");
    expect(await code(t.service.confirmRevision("r1", rev.id, officer))).toBe("409:already_applying");
    t.clock.ms = applying.applyingSince! + APPLYING_STALE_MS + 1;
    const stale = await t.service.getRevision("r1", rev.id);
    expect(stale).toMatchObject({ status: "failed", error: STALE_ERROR });
    expect((await t.service.listRevisions("r1"))[0]).toMatchObject({ status: "failed", error: STALE_ERROR });
    const again = await t.service.confirmRevision("r1", rev.id, officer);
    expect(again.status).toBe("applying");
    await t.service.runApply("r1", rev.id);
    expect(await t.service.getRevision("r1", rev.id)).toMatchObject({ status: "applied", toVersion: 2 });
  });

  it("a corrupt or wrong-shaped revision artifact is skipped in the list, 404 on get, warned without content", async () => {
    const t = await setup([ok1, ok1]);
    await t.comment();
    const a = await t.service.requestRevision("r1", 1, officer);
    const b = await t.service.requestRevision("r1", 1, officer);
    await t.artifacts.put(revisionKey("r1", a.id), "{ not json SECRET-BYTES", "application/json");
    expect((await t.service.listRevisions("r1")).map((r) => r.id)).toEqual([b.id]);
    expect(await code(t.service.getRevision("r1", a.id))).toBe("404:not_found");
    await t.artifacts.put(revisionKey("r1", a.id), JSON.stringify({ id: a.id }), "application/json");
    expect((await t.service.listRevisions("r1")).map((r) => r.id)).toEqual([b.id]);
    expect(t.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.warnings)).not.toContain("SECRET-BYTES");
  });

  it("keeps the saved version when the checks throw, and reports it on the revision", async () => {
    const t = await setup([ok1, ok2], { onSaved: async () => { throw new Error("checks broke"); } });
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    const done = await t.confirm(rev.id, officer);
    expect(done).toMatchObject({ status: "applied", toVersion: 2 });
    expect(done.error).toContain("checks did not finish");
    expect(await t.store.getVersion("r1", 2)).toBeDefined();
    expect((await t.service.getRevision("r1", rev.id)).error).toBeDefined();
  });

  it("409 busy when the run lease is held by someone else", async () => {
    const t = await setup([ok1]);
    await t.comment();
    const rev = await t.service.requestRevision("r1", 1, officer);
    await t.store.acquireLease("r1", "other", 10_000_000, t.clock.ms);
    expect(await code(t.service.confirmRevision("r1", rev.id, officer))).toBe("409:busy");
  });
});

describe("listing (audit-derived index)", () => {
  it("lists a version's revisions in creation order and skips other versions", async () => {
    const t = await setup([ok1, ok1]);
    await t.comment();
    const a = await t.service.requestRevision("r1", 1, officer);
    const b = await t.service.requestRevision("r1", 1, clinician);
    expect((await t.service.listRevisions("r1", 1)).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(await t.service.listRevisions("r1", 2)).toEqual([]);
    expect((await t.service.listRevisions("r1")).map((r) => r.id)).toEqual([a.id, b.id]);
  });
  it("404 for unknown revision, unsafe ids and unknown runs", async () => {
    const t = await setup([]);
    expect(await code(t.service.getRevision("r1", "nope"))).toBe("404:not_found");
    expect(await code(t.service.getRevision("r1", "../x"))).toBe("404:not_found");
    expect(await code(t.service.listRevisions("zzz"))).toBe("404:not_found");
  });
});
