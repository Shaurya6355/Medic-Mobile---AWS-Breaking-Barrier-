export interface ResumeSweepOptions {
  resumeAll: () => Promise<void>;
  intervalMs: number;
  log?: (msg: string, detail?: object) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

// Runs resumeAll every intervalMs so runs left behind by a dead owner are picked
// up once that owner's lease has expired. A tick is skipped while the previous
// sweep is still running. Errors are logged, never thrown. Returns a stop function.
export function startResumeSweep(opts: ResumeSweepOptions): () => void {
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 1) {
    throw new Error("intervalMs must be a positive number");
  }
  const setI = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearI = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let running = false;
  let stopped = false;

  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    void opts
      .resumeAll()
      .catch((e: unknown) => {
        opts.log?.("resume sweep failed", { error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        running = false;
      });
  };

  const handle = setI(tick, opts.intervalMs);
  return () => {
    stopped = true;
    clearI(handle);
  };
}
