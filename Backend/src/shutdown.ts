export interface DeadlineTimers {
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

// Waits for promise up to ms. Resolves true if it fulfilled in time, false if the
// deadline came first (the promise keeps running); rejects if it rejected in time.
export function withDeadline(promise: Promise<unknown>, ms: number, timers: DeadlineTimers = {}): Promise<boolean> {
  const setT = timers.setTimeoutFn ?? ((fn: () => void, t: number) => setTimeout(fn, t));
  const clearT = timers.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<boolean>((resolve, reject) => {
    let done = false;
    const handle = setT(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    promise.then(
      () => {
        if (done) return;
        done = true;
        clearT(handle);
        resolve(true);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        clearT(handle);
        reject(e);
      },
    );
  });
}
