/** Small RFC 6902 subset (add, replace, remove). Pure, no mutation of the input. */
export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type PatchResult = { ok: true; value: unknown } | { ok: false; reason: string };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SERVER_OWNED = ["meta/version", "meta/parent_version"];

function parsePointer(path: string): string[] | undefined {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrIndex(seg: string, len: number, allowEnd: boolean): number | undefined {
  if (allowEnd && seg === "-") return len;
  if (!/^(0|[1-9][0-9]*)$/.test(seg)) return undefined;
  const n = Number(seg);
  return n < len || (allowEnd && n === len) ? n : undefined;
}

export function applyPatch(model: unknown, ops: readonly PatchOp[]): PatchResult {
  let doc: unknown = clone(model);
  for (const [i, op] of ops.entries()) {
    const at = `op ${i}`;
    if (!op || typeof op !== "object" || !["add", "replace", "remove"].includes(op.op)) {
      return { ok: false, reason: `${at}: unsupported op` };
    }
    const segs = parsePointer(op.path);
    if (!segs || segs.length === 0) return { ok: false, reason: `${at}: bad path` };
    if (segs.some((s) => FORBIDDEN_KEYS.has(s))) return { ok: false, reason: `${at}: forbidden path segment` };
    const joined = segs.join("/");
    if (SERVER_OWNED.some((p) => joined === p || joined.startsWith(p + "/"))) {
      return { ok: false, reason: `${at}: ${op.path} is set by the server` };
    }
    if (op.op !== "remove" && !("value" in op)) return { ok: false, reason: `${at}: value required` };
    let parent: unknown = doc;
    for (const s of segs.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const k = arrIndex(s, parent.length, false);
        if (k === undefined) return { ok: false, reason: `${at}: path not found` };
        parent = parent[k];
      } else if (isObj(parent) && Object.hasOwn(parent, s)) parent = parent[s];
      else return { ok: false, reason: `${at}: path not found` };
    }
    const last = segs[segs.length - 1] as string;
    const value = op.op === "remove" ? undefined : clone((op as { value: unknown }).value);
    if (Array.isArray(parent)) {
      const k = arrIndex(last, parent.length, op.op === "add");
      if (k === undefined) return { ok: false, reason: `${at}: index out of range` };
      if (op.op === "add") parent.splice(k, 0, value);
      else if (op.op === "replace") parent[k] = value;
      else parent.splice(k, 1);
    } else if (isObj(parent)) {
      const has = Object.hasOwn(parent, last);
      if (op.op === "add") Object.defineProperty(parent, last, { value, enumerable: true, writable: true, configurable: true });
      else if (!has) return { ok: false, reason: `${at}: path not found` };
      else if (op.op === "replace") parent[last] = value;
      else delete parent[last];
    } else return { ok: false, reason: `${at}: path not found` };
  }
  return { ok: true, value: doc };
}
