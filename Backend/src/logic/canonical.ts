import { createHash } from "node:crypto";

const MAX_DEPTH = 200;

/**
 * Canonical JSON: keys sorted (UTF-16 code unit order) at every depth, no whitespace,
 * -0 -> 0, ECMAScript number formatting, arrays keep order.
 * Accepts only plain objects (prototype Object.prototype or null), dense arrays, finite
 * numbers, strings, booleans and null. Throws a clear error for anything else, for cycles,
 * and for nesting deeper than 200.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", 0, new Set());
}

function ctorName(o: object): string {
  const proto = Object.getPrototypeOf(o) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name ?? "object";
}

function encode(value: unknown, at: string, depth: number, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${at}`);
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object": {
      if (depth >= MAX_DEPTH) throw new Error(`canonicalJson: nesting depth exceeds ${MAX_DEPTH} at ${at}`);
      if (ancestors.has(value)) throw new Error(`canonicalJson: cycle detected at ${at}`);
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (let i = 0; i < value.length; i++) {
            if (!(i in value)) throw new Error(`canonicalJson: sparse array (hole) at ${at}[${i}]`);
            parts.push(encode(value[i], `${at}[${i}]`, depth + 1, ancestors));
          }
          return `[${parts.join(",")}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new Error(`canonicalJson: unsupported ${ctorName(value)} at ${at}`);
        }
        const obj = value as Record<string, unknown>;
        const parts = Object.keys(obj)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${at}.${JSON.stringify(k)}`, depth + 1, ancestors)}`);
        return `{${parts.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${at}`);
  }
}

/**
 * The hashed core of a logic model: everything except `meta` (drafting provenance, not content).
 * `ambiguities` stays in. Returns a shallow copy; the input is not modified. Non-objects pass through.
 */
export function hashableModel<T>(model: T): T extends object ? Omit<T, "meta"> : T {
  if (typeof model !== "object" || model === null || Array.isArray(model) || !("meta" in model)) {
    return model as never;
  }
  const { meta: _meta, ...rest } = model as Record<string, unknown>;
  return rest as never;
}

/** Hex SHA-256 of the canonical JSON (UTF-8) of the hashable model (meta excluded). */
export function snapshotSha(model: unknown): string {
  return createHash("sha256").update(canonicalJson(hashableModel(model)), "utf8").digest("hex");
}
