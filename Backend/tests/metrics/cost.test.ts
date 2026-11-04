import { describe, expect, it } from "vitest";
import { cost, loadPrices, unpricedModelIds } from "../../src/metrics/cost.js";

const prices = { m1: { inPerMTok: 3, outPerMTok: 15 } };

describe("cost", () => {
  it("computes cost from per-million-token prices", () => {
    expect(cost(prices, "m1", 1_000_000, 500_000)).toBe(10.5);
  });

  it("returns undefined for an unpriced model", () => {
    expect(cost(prices, "other", 10, 10)).toBeUndefined();
  });

  it("returns 0 for zero tokens", () => {
    expect(cost(prices, "m1", 0, 0)).toBe(0);
  });
});

describe("loadPrices", () => {
  it("returns an empty table when unset or blank", () => {
    expect(loadPrices({})).toEqual({});
    expect(loadPrices({ PRICES_JSON: "  " })).toEqual({});
  });

  it("parses a valid table", () => {
    const json = JSON.stringify(prices);
    expect(loadPrices({ PRICES_JSON: json })).toEqual(prices);
  });

  it("throws naming PRICES_JSON for malformed JSON", () => {
    expect(() => loadPrices({ PRICES_JSON: "{nope" })).toThrow(/PRICES_JSON/);
  });

  it("throws naming PRICES_JSON for invalid entries", () => {
    const bad = JSON.stringify({ m1: { inPerMTok: -1, outPerMTok: 2 } });
    expect(() => loadPrices({ PRICES_JSON: bad })).toThrow(/PRICES_JSON/);
    const missing = JSON.stringify({ m1: { inPerMTok: 1 } });
    expect(() => loadPrices({ PRICES_JSON: missing })).toThrow(/PRICES_JSON/);
  });
});

describe("unpricedModelIds", () => {
  it("lists configured models with no price, de-duplicated and sorted", () => {
    expect(unpricedModelIds(prices, ["m1", "z", "a", "z"])).toEqual(["a", "z"]);
  });

  it("is empty when every model is priced", () => {
    expect(unpricedModelIds(prices, ["m1"])).toEqual([]);
  });
});
