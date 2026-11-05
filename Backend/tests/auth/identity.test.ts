import { describe, expect, it, vi } from "vitest";
import { bearerToken, identityFromClaims, visibleRuns, type Identity, type IdentityResolver } from "../../src/auth/identity.js";
import { buildServer, type OrchestratorPort } from "../../src/api/server.js";
import { MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { routes } from "../../src/contract/routes.js";
import type { Run } from "../../src/domain/types.js";
import { acceptAnyObjectValidator } from "../../src/steps/logicModelValidator.js";
import { MemoryStore } from "../../src/store/memoryStore.js";

const run = (runId: string, state: Run["state"], createdBy?: string, createdAt = 1): Run => ({ runId, state, createdAt, ...(createdBy ? { createdBy } : {}) });
const me = (roles: Identity["roles"], userId = "u-me"): Identity => ({ userId, roles });

describe("identityFromClaims", () => {
  it("reads sub, email and the groups that are roles", () => {
    expect(identityFromClaims({ sub: "abc", email: "a@x.org", "cognito:groups": ["clinician", "admins", "it"] })).toEqual({ userId: "abc", email: "a@x.org", roles: ["clinician", "it"] });
  });
  it("gives no roles when there are no groups, and refuses a token without sub", () => {
    expect(identityFromClaims({ sub: "abc" })).toEqual({ userId: "abc", roles: [] });
    expect(identityFromClaims({ email: "a@x.org" })).toBeNull();
  });
});

describe("bearerToken", () => {
  it("takes the token from a Bearer header only", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer  abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("visibleRuns", () => {
  const runs = [
    run("old", "awaiting_clinician"), // no owner: hidden from everyone
    run("mine", "extracting", "u-me"),
    run("theirs-processing", "extracting", "u-other"),
    run("theirs-review", "awaiting_clinician", "u-other"),
    run("theirs-locked", "locked", "u-other"),
  ];
  const ids = (who: Identity) => visibleRuns(runs, who).map((r) => r.runId);

  it("shows everyone their own uploads, and no run without an owner", () => {
    expect(ids(me([]))).toEqual(["mine"]);
    expect(ids(me(["program_officer"]))).toEqual(["mine"]);
  });
  it("adds runs waiting for clinical review for a clinician", () => {
    expect(ids(me(["clinician"]))).toEqual(["mine", "theirs-review"]);
  });
  it("adds approved runs for the IT approver", () => {
    expect(ids(me(["it"]))).toEqual(["mine", "theirs-locked"]);
  });
  it("combines roles", () => {
    expect(ids(me(["clinician", "it"]))).toEqual(["mine", "theirs-review", "theirs-locked"]);
  });
});

describe("runs routes with sign-in", () => {
  function setup(identity: IdentityResolver) {
    const store = new MemoryStore();
    let t = 10;
    const orchestrator: OrchestratorPort = {
      createRun: vi.fn(async (pages: number[] | undefined, _f: string, createdBy?: string) => {
        const r: Run = { runId: `run-${t}`, state: "created", createdAt: t++, ...(createdBy ? { createdBy } : {}) };
        if (pages) r.pages = pages;
        await store.createRun(r);
        return r;
      }),
      resume: vi.fn(async () => {}),
      prepareResume: vi.fn(async () => {}),
      onUploaded: vi.fn(async () => {}),
      resumeAll: vi.fn(async () => {}),
      activeCount: vi.fn(() => 0),
      lastStatusChange: vi.fn(() => undefined),
    };
    const server = buildServer({
      orchestrator, store, artifacts: new MemoryArtifactStore(), validator: acceptAnyObjectValidator,
      presign: async (key) => `https://upload.test/${key}`, onVersionSaved: async () => {}, maxPages: 50, identity,
    });
    return { server, store, orchestrator };
  }
  const resolver: IdentityResolver = async (h) =>
    h === "Bearer alice" ? { userId: "alice", roles: ["clinician"] } : h === "Bearer bob" ? { userId: "bob", roles: ["it"] } : null;

  it("refuses POST /runs and GET /runs without a valid token", async () => {
    const { server, orchestrator } = setup(resolver);
    const post = await server.inject({ method: "POST", url: routes.pattern.runs, payload: { filename: "a.pdf" } });
    expect(post.statusCode).toBe(401);
    expect(orchestrator.createRun).not.toHaveBeenCalled();
    const get = await server.inject({ method: "GET", url: routes.pattern.runs, headers: { authorization: "Bearer nobody" } });
    expect(get.statusCode).toBe(401);
  });

  it("takes the signer's identity and role from the token, not the body", async () => {
    const { server } = setup(resolver);
    const url = routes.pattern.sign.replace(":id", "r1").replace(":n", "1").replace(":role", "clinician");
    const asIt = await server.inject({ method: "POST", url, headers: { authorization: "Bearer bob" }, payload: { role: "clinician", userId: "clinician", modelSha: "x" } });
    expect(asIt.statusCode).toBe(403);
    expect(asIt.json()).toMatchObject({ error: "role_not_allowed" });
    const noToken = await server.inject({ method: "POST", url, payload: { role: "clinician", userId: "clinician", modelSha: "x" } });
    expect(noToken.statusCode).toBe(401);
  });

  it("records the uploader and lists each person the runs for their role", async () => {
    const { server, store } = setup(resolver);
    const post = await server.inject({ method: "POST", url: routes.pattern.runs, headers: { authorization: "Bearer alice" }, payload: { filename: "a.pdf" } });
    expect(post.statusCode).toBe(201);
    const { runId } = post.json() as { runId: string };
    expect((await store.getRun(runId))?.createdBy).toBe("alice");
    await store.createRun(run("legacy", "locked")); // no owner

    const alice = await server.inject({ method: "GET", url: routes.pattern.runs, headers: { authorization: "Bearer alice" } });
    expect((alice.json() as Run[]).map((r) => r.runId)).toEqual([runId]);
    const bob = await server.inject({ method: "GET", url: routes.pattern.runs, headers: { authorization: "Bearer bob" } });
    expect((bob.json() as Run[]).map((r) => r.runId)).toEqual([]); // alice's run is not locked yet; legacy has no owner
  });
});
