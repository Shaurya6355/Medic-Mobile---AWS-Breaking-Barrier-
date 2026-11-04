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

  it("allows any non-final state to fail, except the states that wait for a person", () => {
    const human = ["awaiting_officer", "awaiting_clinician", "locked"];
    for (const s of RunState.options.filter((o) => o !== "failed" && !human.includes(o))) {
      expect(canTransition(s, "failed")).toBe(true);
    }
    for (const s of ["awaiting_officer", "awaiting_clinician", "locked"] as const) {
      expect(canTransition(s, "failed")).toBe(false);
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

  // Sign-off pipeline (BRD AR-01 to AR-05, DEC-019).
  it("runs the checks after fill_logic, then waits for the officer", () => {
    expect(canTransition("filling_logic", "checking")).toBe(true);
    expect(canTransition("checking", "awaiting_officer")).toBe(true);
  });

  it("goes officer -> clinician -> locked, in that order only", () => {
    expect(canTransition("awaiting_officer", "awaiting_clinician")).toBe(true);
    expect(canTransition("awaiting_clinician", "locked")).toBe(true);
    expect(canTransition("awaiting_officer", "locked")).toBe(false);
    expect(canTransition("checking", "locked")).toBe(false);
    expect(canTransition("checking", "awaiting_clinician")).toBe(false);
    expect(canTransition("in_review", "locked")).toBe(false);
    expect(canTransition("awaiting_clinician", "awaiting_officer")).toBe(false);
  });

  it("a new version from any review state (locked included) goes back to checking", () => {
    for (const s of ["in_review", "awaiting_officer", "awaiting_clinician", "locked"] as const) {
      expect(canTransition(s, "checking")).toBe(true);
    }
  });

  it("never leaves locked except for the checks of a new version", () => {
    for (const s of RunState.options.filter((o) => o !== "checking")) {
      expect(canTransition("locked", s)).toBe(false);
    }
  });

  it("never resumes a failed run straight into a waiting or locked state", () => {
    for (const s of ["awaiting_officer", "awaiting_clinician", "locked"] as const) {
      expect(canTransition("failed", s)).toBe(false);
    }
  });
});
