/* Edits. Hand edits and AI revisions are both a Patch, so either can be schema-checked and replayed.
   Paths address the spec JSON; a string segment on a list picks the element with that id. */
import type { Question, Spec } from "./types.ts";

export type Path = (string | number)[];
export type Patch =
  | { op: "set"; path: Path; value: unknown }
  | { op: "unset"; path: Path }
  | { op: "addQ"; question: Question }
  | { op: "removeQ"; q: string };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function step(cur: unknown, seg: string | number): unknown {
  if (Array.isArray(cur)) return typeof seg === "number" ? cur[seg] : cur.find(e => (e as { id?: string })?.id === seg);
  return cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
}
export function getAt(x: unknown, path: Path): unknown {
  return path.reduce(step, x);
}
function setAt(x: unknown, path: Path, value: unknown, unset = false) {
  const parent = getAt(x, path.slice(0, -1));
  const last = path[path.length - 1];
  if (parent === undefined || parent === null) throw new Error("No such path: " + path.join("."));
  if (Array.isArray(parent)) {
    const i = typeof last === "number" ? last : parent.findIndex(e => (e as { id?: string })?.id === last);
    if (i < 0) throw new Error("No such path: " + path.join("."));
    if (unset) parent.splice(i, 1); else parent[i] = value;
  } else if (unset) delete (parent as Record<string, unknown>)[last];
  else (parent as Record<string, unknown>)[last] = value;
}

export function applyPatch(spec: Spec, p: Patch): Spec {
  const x = clone(spec);
  switch (p.op) {
    case "set": setAt(x, p.path, clone(p.value)); break;
    case "unset": setAt(x, p.path, undefined, true); break;
    case "addQ":
      x.questions = x.questions.filter(q => q.id !== p.question.id).concat(clone(p.question)).sort((a, b) => a.order - b.order);
      break;
    case "removeQ": x.questions = x.questions.filter(q => q.id !== p.q); break;
  }
  return x;
}
