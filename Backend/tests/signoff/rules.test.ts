import { describe, expect, it } from "vitest";
import { OFFICER_AGENT_ID } from "../../src/signoff/identity.js";
import type { Signature } from "../../src/domain/types.js";
import { approvalStatus, validSignatures, verifyLock } from "../../src/signoff/rules.js";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
const sig = (role: Signature["role"], userId: string, over: Partial<Signature> = {}): Signature => ({
  runId: "r1",
  n: 2,
  modelSha: SHA,
  role,
  userId,
  signedAt: role === "program_officer" ? 10 : 20,
  ...over,
});
const officer = sig("program_officer", OFFICER_AGENT_ID);
const clinician = sig("clinician", "clinician-1");
const locked = { runId: "r1", n: 2, status: "locked" as const, signatures: [officer, clinician] };

describe("validSignatures (AR-03, AR-07)", () => {
  it("keeps the officer then the clinician when both are on this sha", () => {
    expect(validSignatures([officer, clinician], SHA, { runId: "r1", n: 2 })).toEqual([officer, clinician]);
  });
  it("drops every signature given for another sha (an edit invalidates them)", () => {
    expect(validSignatures([officer, clinician], OTHER, { runId: "r1", n: 2 })).toEqual([]);
  });
  it("drops a signature that names another version", () => {
    expect(validSignatures([officer], SHA, { runId: "r1", n: 3 })).toEqual([]);
  });
  it("a clinician signature without an officer signature before it does not count", () => {
    expect(validSignatures([clinician], SHA, { runId: "r1", n: 2 })).toEqual([]);
  });
  it("the clinician signature does not count when the same person signed as officer", () => {
    expect(validSignatures([officer, sig("clinician", OFFICER_AGENT_ID)], SHA, { runId: "r1", n: 2 })).toEqual([officer]);
  });
});

describe("verifyLock (AR-05, AR-08)", () => {
  it("accepts a locked version with both signatures on the same sha", () => {
    expect(verifyLock(SHA, locked)).toEqual({ ok: true });
  });
  it("refuses a version that is not locked", () => {
    const r = verifyLock(SHA, { ...locked, status: "draft" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not locked/);
  });
  it("refuses a version with only the officer signature", () => {
    const r = verifyLock(SHA, { ...locked, signatures: [officer] });
    expect(!r.ok && r.reason).toMatch(/two signatures/);
  });
  it("refuses when the content no longer matches what was signed", () => {
    const r = verifyLock(OTHER, locked);
    expect(!r.ok && r.reason).toMatch(/different content/);
  });
  it("refuses when one person signed both roles", () => {
    const r = verifyLock(SHA, { ...locked, signatures: [officer, sig("clinician", OFFICER_AGENT_ID)] });
    expect(!r.ok && r.reason).toMatch(/officer agent's identity/);
  });
  it("refuses the wrong order", () => {
    const r = verifyLock(SHA, { ...locked, signatures: [clinician, officer] });
    expect(!r.ok && r.reason).toMatch(/officer agent first/);
  });
  it("refuses a clinician signature dated before the officer's", () => {
    const r = verifyLock(SHA, { ...locked, signatures: [officer, sig("clinician", "clinician-1", { signedAt: 5 })] });
    expect(!r.ok && r.reason).toMatch(/before/);
  });
});

describe("approvalStatus", () => {
  it("is awaiting_officer for a new version with zero signatures (AR-02)", () => {
    expect(approvalStatus({ runId: "r1", n: 2 }, SHA, true)).toBe("awaiting_officer");
  });
  it("is awaiting_clinician once the officer signed this sha", () => {
    expect(approvalStatus({ runId: "r1", n: 2, signatures: [officer] }, SHA, true)).toBe("awaiting_clinician");
  });
  it("falls back to awaiting_officer when the officer signed other content", () => {
    expect(approvalStatus({ runId: "r1", n: 2, signatures: [officer] }, OTHER, true)).toBe("awaiting_officer");
  });
  it("is locked when locked, even when it is no longer the latest (AR-09)", () => {
    expect(approvalStatus(locked, SHA, false)).toBe("locked");
  });
  it("is superseded for an older unlocked version", () => {
    expect(approvalStatus({ runId: "r1", n: 2, signatures: [officer] }, SHA, false)).toBe("superseded");
  });
  it("is invalid when a locked version no longer matches its signatures", () => {
    expect(approvalStatus(locked, OTHER, true)).toBe("invalid");
  });
});
