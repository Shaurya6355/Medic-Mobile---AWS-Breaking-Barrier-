import { describe, expect, it, vi } from "vitest";
import { runBackground } from "../../src/api/background.js";

const never = (): Promise<void> => new Promise(() => {});

describe("runBackground", () => {
  it.each(["container", "agentcore"] as const)("%s: returns without waiting", async (mode) => {
    const onError = vi.fn();
    await runBackground(mode, never(), onError);
    expect(onError).not.toHaveBeenCalled();
  });
  it.each(["container", "agentcore"] as const)("%s: reports a later rejection", async (mode) => {
    const onError = vi.fn();
    await runBackground(mode, Promise.reject(new Error("x")), onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("lambda: waits for completion", async () => {
    let done = false;
    await runBackground("lambda", new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 10)), vi.fn());
    expect(done).toBe(true);
  });
  it("lambda: a rejection is reported and does not throw", async () => {
    const onError = vi.fn();
    await runBackground("lambda", Promise.reject(new Error("x")), onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("lambda: stops waiting at the deadline and reports it", async () => {
    const onError = vi.fn();
    const onDeadline = vi.fn();
    await runBackground("lambda", never(), onError, 5, onDeadline);
    expect(onError).not.toHaveBeenCalled();
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });
  it("lambda: no deadline report when work finishes in time", async () => {
    const onDeadline = vi.fn();
    await runBackground("lambda", Promise.resolve(), vi.fn(), 50, onDeadline);
    expect(onDeadline).not.toHaveBeenCalled();
  });
});
