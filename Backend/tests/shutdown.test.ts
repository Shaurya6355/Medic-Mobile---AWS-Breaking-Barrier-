import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "../src/shutdown.js";

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true when the promise settles before the deadline, and clears the timer", async () => {
    const p = withDeadline(Promise.resolve("x"), 1000);
    await expect(p).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves false at the deadline when the promise never settles", async () => {
    const p = withDeadline(new Promise<void>(() => {}), 1000);
    let result: boolean | undefined;
    void p.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  it("rejects with the promise's error if it fails before the deadline", async () => {
    const p = withDeadline(Promise.reject(new Error("drain failed")), 1000);
    await expect(p).rejects.toThrow("drain failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the injected timer functions", async () => {
    const setTimeoutFn = vi.fn((fn: () => void) => {
      fn();
      return 7;
    });
    const clearTimeoutFn = vi.fn();
    const p = withDeadline(new Promise<void>(() => {}), 50, { setTimeoutFn, clearTimeoutFn });
    await expect(p).resolves.toBe(false);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 50);
  });
});
