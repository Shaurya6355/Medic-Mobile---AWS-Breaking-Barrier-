/**
 * One JSON line per event on stdout (CloudWatch in Lambda, docker logs in a container).
 * Never log env values, request or message bodies, guideline text or credentials: ids, names, counts,
 * timings and short error messages only.
 */
export type Log = (msg: string, detail?: object) => void;

export const jsonLog: Log = (msg, detail) => {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...detail }));
  } catch {
    // A detail that cannot be serialised must never break the caller.
    console.log(JSON.stringify({ at: new Date().toISOString(), msg, detail: "unserialisable" }));
  }
};

export const noLog: Log = () => {};

/** A logger that never throws, whatever the one it wraps does. */
export function safeLog(log: Log | undefined): Log {
  if (!log) return noLog;
  return (msg, detail) => {
    try {
      log(msg, detail);
    } catch {
      // Logging must never change what the pipeline does.
    }
  };
}

export const errorMessage = (e: unknown, max = 500): string => (e instanceof Error ? e.message : String(e)).slice(0, max);
