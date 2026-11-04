import { describe, expect, it } from "vitest";
import { parseModelValidator } from "../../src/steps/logicModelValidator.js";
import { saveVersion } from "../../src/versions/saveVersion.js";
import { officerFixed, seed } from "../signoff/helpers.js";

async function setup() {
  const s = await seed("awaiting_officer", [officerFixed()]);
  const calls: number[] = [];
  const deps = {
    store: s.store,
    artifacts: s.artifacts,
    validator: parseModelValidator,
    onVersionSaved: async (_r: string, n: number) => {
      calls.push(n);
    },
    now: () => s.clock.ms++,
  };
  const body = (v: number) => ({ ...(officerFixed() as any), meta: { ...(officerFixed() as any).meta, version: v, parent_version: v - 1 } });
  return { ...s, deps, calls, body };
}

describe("saveVersion", () => {
  it("saves, records origin and change record, calls onVersionSaved", async () => {
    const s = await setup();
    const r = await saveVersion(s.deps, { runId: "r1", parentVersion: 1, body: s.body(2), author: "ann", origin: "api" });
    expect(r).toEqual({ ok: true, n: 2, checks_status: "ok" });
    const v = (await s.store.getVersion("r1", 2))!;
    expect(v.origin).toBe("api");
    expect(v.changeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.calls).toEqual([2]);
  });

  it("refuses stale parent (409), unknown run (404), bad body (422), wrong meta (422)", async () => {
    const s = await setup();
    expect(await saveVersion(s.deps, { runId: "r1", parentVersion: 5, body: s.body(2), author: "a", origin: "api" })).toMatchObject({ ok: false, status: 409, error: "conflict" });
    expect(await saveVersion(s.deps, { runId: "nope", parentVersion: 1, body: s.body(2), author: "a", origin: "api" })).toMatchObject({ ok: false, status: 404 });
    expect(await saveVersion(s.deps, { runId: "r1", parentVersion: 1, body: { x: 1 }, author: "a", origin: "api" })).toMatchObject({ ok: false, status: 422, error: "invalid_logic_model" });
    expect(await saveVersion(s.deps, { runId: "r1", parentVersion: 1, body: s.body(7), author: "a", origin: "api" })).toMatchObject({ ok: false, status: 422, error: "version_mismatch" });
  });

  it("reports failed checks but keeps the version", async () => {
    const s = await setup();
    s.deps.onVersionSaved = async () => {
      throw new Error("boom");
    };
    const r = await saveVersion(s.deps, { runId: "r1", parentVersion: 1, body: s.body(2), author: "a", origin: "api" });
    expect(r).toMatchObject({ ok: true, n: 2, checks_status: "failed" });
    expect(await s.store.getVersion("r1", 2)).toBeDefined();
  });

  it("same idempotencyKey returns the first result without a new version", async () => {
    const s = await setup();
    const input = { runId: "r1", parentVersion: 1, body: s.body(2), author: "a", origin: "api" as const, idempotencyKey: "k1" };
    const a = await saveVersion(s.deps, input);
    const b = await saveVersion(s.deps, input);
    expect(b).toEqual(a);
    expect(await s.store.listVersions("r1")).toHaveLength(2);
    expect(s.calls).toEqual([2]);
  });
});
