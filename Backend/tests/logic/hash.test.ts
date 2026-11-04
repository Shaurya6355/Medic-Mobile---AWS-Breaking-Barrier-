import { describe, expect, it } from "vitest";
import { modelSha } from "../../src/logic/hash.js";
import { parseModel } from "../../src/logic/schema.js";
import { rawV1, v1 } from "./helpers.js";

const GOLDEN_SHA = "3dcbacce7f6065dd4394c6cea1b1e4b268c607e8fc487d40ad4a67d804b22955";

describe("modelSha", () => {
  it("is 64 hex and pinned for the v1 fixture", () => {
    expect(modelSha(v1())).toMatch(/^[0-9a-f]{64}$/);
    expect(modelSha(v1())).toBe(GOLDEN_SHA);
  });
  it("does not depend on key order", () => {
    const raw = rawV1();
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    const a = parseModel(raw);
    const b = parseModel(reordered);
    expect(a.ok && b.ok && modelSha(a.value) === modelSha(b.value)).toBe(true);
  });
  it("changes when a threshold changes", () => {
    const raw = rawV1();
    raw.derived[0].definition.all[1].any[0].all[2].value = 51;
    const r = parseModel(raw);
    expect(r.ok && modelSha(r.value)).not.toBe(modelSha(v1()));
  });
  it("ignores created_at, created_by and change_note", () => {
    const raw = rawV1();
    raw.meta.change_note = "something else";
    raw.meta.created_by = "someone";
    raw.meta.created_at = "2030-01-01T00:00:00Z";
    const r = parseModel(raw);
    expect(r.ok && modelSha(r.value)).toBe(modelSha(v1()));
  });
  it("includes version and parent_version", () => {
    const raw = rawV1();
    raw.meta.version = 2;
    raw.meta.parent_version = 1;
    const r = parseModel(raw);
    expect(r.ok && modelSha(r.value)).not.toBe(modelSha(v1()));
  });
});
