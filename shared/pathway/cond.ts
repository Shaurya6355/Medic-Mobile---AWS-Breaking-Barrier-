/* The condition language: AST helpers, a text form people can read and edit, and its parser.

   Text form (what the editor shows):
     expr  := or
     or    := and ("or" and)*
     and   := unary ("and" unary)*
     unary := "not" unary | "(" expr ")" | leaf
     leaf  := field "is" ("yes" | "no") | field (">=" | "<=" | "<" | ">" | "=") number
   Example: danger_sign is yes and (fast_breathing is yes or chest_indrawing is yes) */
import type { Cond, Leaf, Op } from "./types.ts";

export const isLeaf = (c: Cond): c is Leaf => "field" in c;

const SYM: Record<Op, string> = { is_yes: "is yes", is_no: "is no", at_least: ">=", at_most: "<=", less_than: "<", greater_than: ">", equals: "=" };
const OP_OF: Record<string, Op> = { ">=": "at_least", "<=": "at_most", "<": "less_than", ">": "greater_than", "=": "equals" };

/** Every leaf, with its JSON path relative to the condition. */
export function leaves(c: Cond, path: (string | number)[] = []): { leaf: Leaf; path: (string | number)[]; parent: Cond | null }[] {
  const out: { leaf: Leaf; path: (string | number)[]; parent: Cond | null }[] = [];
  const go = (x: Cond, p: (string | number)[], parent: Cond | null) => {
    if (isLeaf(x)) out.push({ leaf: x, path: p, parent });
    else if ("all" in x) x.all.forEach((y, i) => go(y, [...p, "all", i], x));
    else if ("any" in x) x.any.forEach((y, i) => go(y, [...p, "any", i], x));
    else go(x.not, [...p, "not"], x);
  };
  go(c, path, null);
  return out;
}
export const refs = (c: Cond) => [...new Set(leaves(c).map(l => l.leaf.field))];

/* ---------- Printing ---------- */
function prec(c: Cond) { return isLeaf(c) || "not" in c ? 3 : "all" in c ? 2 : 1; }
export function print(c: Cond, leaf: (l: Leaf) => string = l => l.field + " " + SYM[l.op] + (l.value === undefined ? "" : " " + l.value)): string {
  const wrap = (x: Cond, min: number) => (prec(x) < min ? "(" + print(x, leaf) + ")" : print(x, leaf));
  if (isLeaf(c)) return leaf(c);
  if ("all" in c) return c.all.length ? c.all.map(x => wrap(x, 2)).join(" and ") : "true";
  if ("any" in c) return c.any.length ? c.any.map(x => wrap(x, 3)).join(" or ") : "false";
  return "not " + wrap(c.not, 3);
}
/** Plain English for the flow chart. `name` turns a field id into words. */
export function humanize(c: Cond, name: (field: string) => string, unit: (field: string) => string = () => ""): string {
  const words: Record<Op, string> = { is_yes: "", is_no: "", at_least: "at least", at_most: "at most", less_than: "under", greater_than: "over", equals: "exactly" };
  return print(c, l => {
    if (l.op === "is_yes") return name(l.field);
    if (l.op === "is_no") return "no " + name(l.field);
    const u = unit(l.field);
    return name(l.field) + " " + words[l.op] + " " + l.value + (u ? " " + u : "");
  });
}

/* ---------- Parsing ---------- */
export class CondSyntaxError extends Error {}
type Tok = { t: "id" | "num" | "op" | "(" | ")" | "kw"; v: string; at: number };
function lex(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(>=|<=|<|>|=)|(\()|(\))|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new CondSyntaxError("Unexpected character at " + (i + 1) + ": " + JSON.stringify(s.slice(i).trim()[0]));
    const at = m.index + m[0].length - (m[1] || m[2] || m[3] || m[4] || m[5]).length;
    if (m[1]) out.push({ t: "op", v: m[1], at });
    else if (m[2]) out.push({ t: "(", v: "(", at });
    else if (m[3]) out.push({ t: ")", v: ")", at });
    else if (m[4]) out.push({ t: "num", v: m[4], at });
    else {
      const w = m[5];
      out.push(["and", "or", "not", "is", "yes", "no"].includes(w.toLowerCase()) ? { t: "kw", v: w.toLowerCase(), at } : { t: "id", v: w, at });
    }
    i = re.lastIndex;
  }
  return out;
}
export function parse(src: string): Cond {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const fail = (msg: string): never => { throw new CondSyntaxError(msg + (peek() ? " at " + (peek().at + 1) : " at the end")); };
  const kw = (v: string) => peek()?.t === "kw" && peek().v === v;
  const group = (k: "all" | "any", xs: Cond[]): Cond => {
    const flat: Cond[] = [];
    xs.forEach(x => { if (!isLeaf(x) && k in x) flat.push(...(x as Record<string, Cond[]>)[k]); else flat.push(x); });
    return flat.length === 1 ? flat[0] : (k === "all" ? { all: flat } : { any: flat });
  };
  function or(): Cond { const xs = [and()]; while (kw("or")) { i++; xs.push(and()); } return group("any", xs); }
  function and(): Cond { const xs = [unary()]; while (kw("and")) { i++; xs.push(unary()); } return group("all", xs); }
  function unary(): Cond {
    if (kw("not")) { i++; return { not: unary() }; }
    if (peek()?.t === "(") { i++; const e = or(); if (peek()?.t !== ")") fail("Expected )"); i++; return e; }
    return leaf();
  }
  function leaf(): Cond {
    const f = peek();
    if (f?.t !== "id") return fail("Expected a field name");
    i++;
    if (kw("is")) {
      i++;
      if (kw("yes")) { i++; return { field: f.v, op: "is_yes" }; }
      if (kw("no")) { i++; return { field: f.v, op: "is_no" }; }
      return fail("Expected yes or no");
    }
    const o = peek();
    if (o?.t !== "op") return fail("Expected is, >=, <=, <, > or =");
    i++;
    const n = peek();
    if (n?.t !== "num") return fail("Expected a number");
    i++;
    return { field: f.v, op: OP_OF[o.v], value: Number(n.v) };
  }
  if (!toks.length) throw new CondSyntaxError("Empty condition");
  const e = or();
  if (i < toks.length) fail("Unexpected " + JSON.stringify(peek().v));
  return e;
}

/* ---------- XLSForm (ODK XPath) ---------- */
export function xpath(c: Cond): string {
  const ref = (f: string) => "${" + f + "}";
  const xp: Record<Op, string> = { is_yes: "= 'yes'", is_no: "= 'no'", at_least: ">=", at_most: "<=", less_than: "<", greater_than: ">", equals: "=" };
  if (isLeaf(c)) return ref(c.field) + " " + xp[c.op] + (c.value === undefined ? "" : " " + c.value);
  if ("all" in c) return c.all.length ? c.all.map(x => (isLeaf(x) ? xpath(x) : "(" + xpath(x) + ")")).join(" and ") : "true()";
  if ("any" in c) return c.any.length ? c.any.map(x => (isLeaf(x) ? xpath(x) : "(" + xpath(x) + ")")).join(" or ") : "false()";
  return "not(" + xpath(c.not) + ")";
}
