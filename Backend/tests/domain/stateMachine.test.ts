import { describe, expect, it } from "vitest";
import { canTransition } from "../../src/domain/stateMachine.js";
import { RunState } from "../../src/contract/schemas.js";

describe("canTransition", () => {
  it("allows the forward pipeline", () => {
    expect(canTransition("created", "ingesting")).toBe(true);
    expect(canTransition("ingesting", "extracting")).toBe(true);
    expect(canTransition("extracting", "filling_logic")).toBe(true);
    expect(canTransition("filling_logic", "in_review")).toBe(true);
  });

  it("allows in_review -> checking -> in_review", () => {
    expect(canTransition("in_review", "checking")).toBe(true);
    expect(canTransition("checking", "in_review")).toBe(true);
  });

  it("allows any non-final state to fail", () => {
    for (const s of RunState.options.filter((o) => o !== "failed")) {
      expect(canTransition(s, "failed")).toBe(true);
    }
  });

  it("allows resuming a failed run into a work state only", () => {
    for (const s of ["ingesting", "extracting", "filling_logic", "checking"] as const) {
      expect(canTransition("failed", s)).toBe(true);
    }
    expect(canTransition("failed", "created")).toBe(false);
    expect(canTransition("failed", "in_review")).toBe(false);
    expect(canTransition("failed", "failed")).toBe(false);
  });

  it("rejects backward and skipping transitions", () => {
    expect(canTransition("extracting", "created")).toBe(false);
    expect(canTransition("in_review", "ingesting")).toBe(false);
    expect(canTransition("created", "extracting")).toBe(false);
    expect(canTransition("created", "created")).toBe(false);
  });
});
