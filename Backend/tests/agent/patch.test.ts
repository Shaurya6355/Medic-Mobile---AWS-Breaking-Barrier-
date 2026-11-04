import { describe, it, expect } from "vitest";
import { applyPatch } from "../../src/agent/patch.js";
import { behaviourDiff, isBehaviourPreserving } from "../../src/agent/behaviourDiff.js";
import { v1 } from "../logic/helpers.js";

describe("LLM05 improper output handling: patch", () => {
  it("applies add/replace/remove without mutating the input", () => {
    const doc = { a: [1, 2], b: { c: 1 } };
    const r = applyPatch(doc, [
      { op: "add", path: "/a/-", value: 3 },
      { op: "replace", path: "/b/c", value: 2 },
      { op: "remove", path: "/a/0" },
    ]);
    expect(r).toEqual({ ok: true, value: { a: [2, 3], b: { c: 2 } } });
    expect(doc).toEqual({ a: [1, 2], b: { c: 1 } });
  });
  it("rejects bad paths and unknown ops", () => {
    expect(applyPatch({}, [{ op: "replace", path: "/x", value: 1 }]).ok).toBe(false);
    expect(applyPatch({}, [{ op: "move", path: "/x" } as never]).ok).toBe(false);
  });
});

describe("LLM06 excessive agency: server-owned and prototype paths", () => {
  it("refuses meta/version and meta/parent_version", () => {
    const d = { meta: { version: 1, parent_version: null } };
    expect(applyPatch(d, [{ op: "replace", path: "/meta/version", value: 9 }]).ok).toBe(false);
    expect(applyPatch(d, [{ op: "replace", path: "/meta/parent_version", value: 9 }]).ok).toBe(false);
  });
  it("refuses __proto__ and constructor paths", () => {
    expect(applyPatch({}, [{ op: "add", path: "/__proto__/x", value: 1 }]).ok).toBe(false);
    expect(applyPatch({ a: {} }, [{ op: "add", path: "/a/constructor", value: 1 }]).ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("LLM06 excessive agency: behaviour guard", () => {
  it("accepts a metadata-only change", () => {
    const m = v1();
    const n = structuredClone(m);
    n.meta.change_note = "fixed citation";
    expect(isBehaviourPreserving(behaviourDiff(m, n))).toBe(true);
  });
  it("detects a clinical change", () => {
    const m = v1();
    const n = structuredClone(m);
    const r = n.rules.find((x) => x.when !== "otherwise")!;
    const other = n.outcomes.find((o) => o.id !== r.outcome)!;
    r.outcome = other.id;
    const d = behaviourDiff(m, n);
    expect(d.changes.length).toBeGreaterThan(0);
    expect(isBehaviourPreserving(d)).toBe(false);
  });
  it("LLM10: fails closed when truncated", () => {
    const m = v1();
    const d = behaviourDiff(m, structuredClone(m), { maxPoints: 1 });
    expect(d.truncated).toBe(true);
    expect(isBehaviourPreserving(d)).toBe(false);
  });
});
