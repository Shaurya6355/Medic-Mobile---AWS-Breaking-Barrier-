import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startResumeSweep } from "../../src/engine/sweep.js";

describe("startResumeSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls resumeAll every interval", async () => {
    const resumeAll = vi.fn(async () => {});
    const stop = startResumeSweep({ resumeAll, intervalMs: 1000 });
    expect(resumeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumeAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(resumeAll).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips a tick while the previous run is still in progress", async () => {
    let finish!: () => void;
    const resumeAll = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const stop = startResumeSweep({ resumeAll, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumeAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resumeAll).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumeAll).toHaveBeenCalledTimes(2);
    stop();
  });

  it("swallows and logs errors, and keeps sweeping", async () => {
    const log = vi.fn();
    const resumeAll = vi.fn(async () => {
      throw new Error("store down");
    });
    const stop = startResumeSweep({ resumeAll, intervalMs: 1000, log });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledWith("resume sweep failed", { error: "store down" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumeAll).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop prevents further runs", async () => {
    const resumeAll = vi.fn(async () => {});
    const stop = startResumeSweep({ resumeAll, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resumeAll).toHaveBeenCalledTimes(1);
  });

  it("uses injected timer functions", () => {
    const handle = { id: 1 };
    const setIntervalFn = vi.fn(() => handle);
    const clearIntervalFn = vi.fn();
    const stop = startResumeSweep({
      resumeAll: async () => {},
      intervalMs: 500,
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    });
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 500);
    stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });

  it("rejects a non-positive interval", () => {
    expect(() => startResumeSweep({ resumeAll: async () => {}, intervalMs: 0 })).toThrow(/intervalMs/);
  });
});
