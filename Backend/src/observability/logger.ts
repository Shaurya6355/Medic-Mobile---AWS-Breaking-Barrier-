// Structured logs and CloudWatch metrics for the orchestrator.
//
// Everything goes to stdout as one JSON object per line. On Lambda and in containers the platform ships
// stdout to CloudWatch Logs, so no SDK call is needed. A metric line carries the CloudWatch Embedded
// Metric Format block (`_aws`), so CloudWatch turns it into a metric in the NAMESPACE below at no extra
// cost per call; the same line is still a searchable log record (Logs Insights).
//
// Privacy rule (same as before): never log environment values, request bodies, message bodies, guideline
// text, comments or answers. Fields are a small safe set (ids, states, counts, durations, tokens, cost);
// `cleanFields` drops everything else.

export const NAMESPACE = "NoCodeChtConfig";

export type Level = "debug" | "info" | "warn" | "error";
export type Unit = "Count" | "Milliseconds" | "None" | "Percent";
export type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 300;
// Keys whose value is content, not metadata. Dropped whatever their type.
const DENY = /secret|password|authorization|credential|sessiontoken|accesskey|^(body|text|comment|resolution|quote|answer|prompt|message|filename|raw|content)s?$/i;

/** Only scalars, short strings, and keys that are not content. Arrays and objects are summarised by size. */
export function cleanFields(fields: Fields | undefined): Fields {
  const out: Fields = {};
  if (fields === undefined) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || DENY.test(k)) continue;
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...` : v;
    else if (Array.isArray(v)) out[`${k}Count`] = v.length;
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** One metric data point (+ a log line). `dims` become CloudWatch dimensions (keep them low-cardinality); the total without dimensions is published too, for alarms. */
  metric(name: string, value: number, unit?: Unit, dims?: Record<string, string>, fields?: Fields): void;
  /** A logger that adds `base` to every line (for example the run id). */
  child(base: Fields): Logger;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => number;
  minLevel?: Level;
  /** Added to every line, for example { service: "orchestrator" }. */
  base?: Fields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = opts.now ?? Date.now;
  const min = LEVELS[opts.minLevel ?? ((process.env["LOG_LEVEL"] as Level | undefined) ?? "info")] ?? LEVELS.info;
  const base = cleanFields(opts.base);

  const emit = (level: Level, msg: string, fields: Fields | undefined, extra?: Fields): void => {
    if (LEVELS[level] < min) return;
    const at = now();
    write(JSON.stringify({ at: new Date(at).toISOString(), level, msg, ...base, ...cleanFields(fields), ...extra }));
  };

  const logger: Logger = {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    metric(name, value, unit = "Count", dims = {}, fields) {
      if (!Number.isFinite(value)) return;
      const dimNames = Object.keys(dims);
      const emf = {
        Timestamp: now(),
        CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: dimNames.length > 0 ? [dimNames, []] : [[]], Metrics: [{ Name: name, Unit: unit }] }],
      };
      // Metrics are always written (level filter does not apply): an alarm must not depend on LOG_LEVEL.
      write(JSON.stringify({ at: new Date(now()).toISOString(), level: "info", msg: "metric", ...base, ...cleanFields(fields), ...dims, [name]: value, _aws: emf }));
    },
    child: (b) => createLogger({ ...opts, write, now, base: { ...base, ...cleanFields(b) } }),
  };
  return logger;
}

/** A logger that records nothing (tests, callers without observability). */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  metric() {},
  child: () => nullLogger,
};
