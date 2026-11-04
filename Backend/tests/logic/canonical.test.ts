import { describe, expect, it } from "vitest";
import { canonicalJson, hashableModel, snapshotSha } from "../../src/logic/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("normalizes -0 to 0", () => {
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
  });
  it("rejects NaN, Infinity, undefined and functions", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: -Infinity })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson([1, undefined])).toThrow();
  });
  it("rejects other non-JSON values", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: Symbol("s") })).toThrow();
  });
  it("formats numbers per ECMAScript", () => {
    expect(canonicalJson([1e21, 1e-7, 0.1 + 0.2, 5e-324, 100, -1.5])).toBe(
      "[1e+21,1e-7,0.30000000000000004,5e-324,100,-1.5]",
    );
  });
  it("sorts keys by UTF-16 code unit (astral before U+FFFF)", () => {
    const o = { "\uffff": 1, "\u{1F600}": 2, b: 3, B: 4, "\u00e9": 5 };
    expect(Object.keys(JSON.parse(canonicalJson(o)))).toEqual(["B", "b", "\u00e9", "\u{1F600}", "\uffff"]);
  });
  it("rejects non-plain objects", () => {
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(/Date/);
    expect(() => canonicalJson(new Map([[1, 2]]))).toThrow(/Map/);
    expect(() => canonicalJson(new Set([1]))).toThrow(/Set/);
    expect(() => canonicalJson({ a: new Number(1) })).toThrow(/Number/);
    expect(() => canonicalJson(new Uint8Array(2))).toThrow(/Uint8Array/);
    expect(() => canonicalJson(new (class Foo {})())).toThrow(/Foo/);
  });
  it("accepts null-prototype objects and own __proto__ keys", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["b"] = 1;
    o["a"] = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
    expect(canonicalJson(JSON.parse('{"__proto__":1}'))).toBe('{"__proto__":1}');
  });
  it("rejects sparse arrays", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 3])).toThrow(/hole|sparse/i);
    expect(() => canonicalJson(new Array(3))).toThrow(/hole|sparse/i);
  });
  it("rejects cycles with a clear error", () => {
    const o: Record<string, unknown> = {};
    o["self"] = o;
    expect(() => canonicalJson(o)).toThrow(/cycle|circular/i);
    const a: unknown[] = [];
    a.push(a);
    expect(() => canonicalJson(a)).toThrow(/cycle|circular/i);
  });
  it("accepts shared (non-cyclic) references", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
  it("rejects nesting deeper than 200 with a clear error, accepts 200", () => {
    const deep = (n: number) => {
      let v: unknown = 1;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(() => canonicalJson(deep(100000))).toThrow(/depth/i);
    expect(() => canonicalJson(deep(201))).toThrow(/depth/i);
    expect(() => canonicalJson(deep(200))).not.toThrow();
  });
  it("keeps unicode as-is and handles null", () => {
    expect(canonicalJson({ k: "é☃", n: null })).toBe('{"k":"é☃","n":null}');
  });
});

describe("snapshotSha", () => {
  const base = { a: 1, b: { c: [1, 2, 3], d: "x" } };
  it("is a 64 char hex digest", () => {
    expect(snapshotSha(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is unchanged by key reordering", () => {
    const reordered = { b: { d: "x", c: [1, 2, 3] }, a: 1 };
    expect(snapshotSha(reordered)).toBe(snapshotSha(base));
  });
  it("changes when a value changes", () => {
    expect(snapshotSha({ ...base, a: 2 })).not.toBe(snapshotSha(base));
  });
  it("changes when array order changes", () => {
    expect(snapshotSha({ a: 1, b: { c: [3, 2, 1], d: "x" } })).not.toBe(snapshotSha(base));
  });
  it("is stable for seeded permutations of nested keys", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
    const build = (order: string[], depth: number): Record<string, unknown> =>
      Object.fromEntries(order.map((k) => [k, depth === 0 ? keys.indexOf(k) : build(shuffle(keys), depth - 1)]));
    const shuffle = (a: string[]) => {
      const b = [...a];
      for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [b[i], b[j]] = [b[j]!, b[i]!];
      }
      return b;
    };
    const expected = snapshotSha(build(keys, 2));
    // build() reshuffles children each call, so every permutation differs structurally only in key order
    for (let n = 0; n < 50; n++) expect(snapshotSha(build(shuffle(keys), 2))).toBe(expected);
  });
});

describe("hashableModel", () => {
  const model = { pathway_id: "p", meta: { drafted_by: "model-x" }, ambiguities: [{ id: "a1" }], tables: [1, 2] };
  it("drops meta and keeps everything else, without mutating the input", () => {
    const h = hashableModel(model);
    expect(h).toEqual({ pathway_id: "p", ambiguities: [{ id: "a1" }], tables: [1, 2] });
    expect("meta" in h).toBe(false);
    expect(model.meta).toEqual({ drafted_by: "model-x" });
  });
  it("snapshotSha ignores meta but not ambiguities or other fields", () => {
    const { meta: _meta, ...without } = model;
    expect(snapshotSha(model)).toBe(snapshotSha(without));
    expect(snapshotSha({ ...model, meta: { drafted_by: "other" } })).toBe(snapshotSha(model));
    expect(snapshotSha({ ...model, ambiguities: [] })).not.toBe(snapshotSha(model));
    expect(snapshotSha({ ...model, pathway_id: "q" })).not.toBe(snapshotSha(model));
  });
  it("snapshotSha still accepts non-object values deterministically", () => {
    expect(snapshotSha([1, 2])).toBe(snapshotSha([1, 2]));
    expect(snapshotSha("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
