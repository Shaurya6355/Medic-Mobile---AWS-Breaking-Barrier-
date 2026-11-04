/* Back end of the compiler: flow graph (what the review UI draws), XLSForm survey rows (what cht-conf builds),
   source quotes (what the quote check reads), and test generation (boundary patients and mutants). Deterministic. */
import { leaves, xpath } from "./cond.ts";
import { byOrder, byPriority, derivedOrder, evaluate, visibleAnswers } from "./evaluate.ts";
import { applyPatch, type Path } from "./patch.ts";
import { item, srcList, type Answers, type Cond, type ItemId, type Leaf, type Source, type Sources, type Spec } from "./types.ts";

/* ---------- Flow graph ---------- */
export type GKind = "start" | "decision" | "outcome" | "task";
export interface GNode { id: ItemId; kind: GKind; key: string }
export interface GEdge { from: ItemId; to: ItemId; label: "" | "yes" | "no" | "task" }

/** Rules in priority order become a chain: each rule's yes goes to its outcome, no goes to the next rule. */
export function toGraph(spec: Spec): { nodes: GNode[]; edges: GEdge[] } {
  const nodes: GNode[] = [{ id: item.scope, kind: "start", key: "" }];
  const edges: GEdge[] = [];
  const rules = byPriority(spec);
  const entry = (i: number): ItemId | null => {
    const r = rules[i];
    if (!r) return null;
    return r.when === "otherwise" ? item.out(r.outcome) : item.rule(r.id);
  };
  const first = entry(0);
  if (first) edges.push({ from: item.scope, to: first, label: "" });
  rules.forEach((r, i) => {
    if (r.when === "otherwise") return;
    nodes.push({ id: item.rule(r.id), kind: "decision", key: r.id });
    edges.push({ from: item.rule(r.id), to: item.out(r.outcome), label: "yes" });
    const next = entry(i + 1);
    if (next) edges.push({ from: item.rule(r.id), to: next, label: "no" });
  });
  spec.outcomes.forEach(o => {
    nodes.push({ id: item.out(o.id), kind: "outcome", key: o.id });
    if (o.follow_up) {
      nodes.push({ id: item.fu(o.id), kind: "task", key: o.id });
      edges.push({ from: item.out(o.id), to: item.fu(o.id), label: "task" });
    }
  });
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: edges.filter(e => ids.has(e.from) && ids.has(e.to)) };
}

/* ---------- XLSForm ---------- */
export type XlsRow = [type: string, name: string, label: string, relevant: string, calc: string];

export function toXlsForm(spec: Spec): XlsRow[] {
  const ref = (x: string) => "${" + x + "}";
  const rows: XlsRow[] = [["begin group", "inputs", "Inputs", "", ""], ["string", "source", "", "", "(CHT contact inputs)"], ["end group", "", "", "", ""]];
  byOrder(spec).forEach(q => {
    const c = q.constraint;
    const con = [c?.min !== undefined ? ". >= " + c.min : "", c?.max !== undefined ? ". <= " + c.max : ""].filter(Boolean).join(" and ");
    rows.push([q.answer_type === "yes_no" ? "select_one yes_no" : "integer", q.id, q.label, q.shown_when ? xpath(q.shown_when) : "", con]);
  });
  const defs = new Map(spec.derived.map(d => [d.id, d.definition]));
  derivedOrder(spec).forEach(id => rows.push(["calculate", id, "", "", "if(" + xpath(defs.get(id)!) + ", 'yes', 'no')"]));
  const rules = byPriority(spec);
  const cls = rules.reduceRight((acc, r) => (r.when === "otherwise" ? "'" + r.outcome + "'" : "if(" + xpath(r.when) + ", '" + r.outcome + "', " + acc + ")"), "''");
  rows.push(["calculate", "classification", "", "", cls]);
  spec.outcomes.forEach(o => {
    const rel = ref("classification") + " = '" + o.id + "'";
    rows.push(["note", "n_" + o.id, o.title.replace(/[.\s]+$/, "").toUpperCase() + ". " + o.actions.map(a => a.text).join(" "), rel, ""]);
    if (o.follow_up?.due_in_days != null) rows.push(["calculate", "fu_" + o.id + "_due", "", rel, "format-date-time(decimal-date-time(today()) + " + o.follow_up.due_in_days + ", '%Y-%m-%d')"]);
  });
  return rows;
}

export interface RowDiff { k: "same" | "add" | "del"; r: XlsRow }
export function rowDiff(a: XlsRow[], b: XlsRow[]): RowDiff[] {
  const keyOf = (r: XlsRow, i: number) => (r[1] || r[0]) + "#" + (r[1] ? "" : i);
  const index = (rs: XlsRow[]) => { const o: Record<string, XlsRow> = {}; rs.forEach((r, i) => { o[keyOf(r, i)] = r; }); return o; };
  const A = index(a), B = index(b), out: RowDiff[] = [];
  const keys = b.map(keyOf);
  a.forEach((r, i) => { const k = keyOf(r, i); if (!keys.includes(k)) keys.splice(Math.min(i, keys.length), 0, k); });
  keys.forEach(k => {
    if (A[k] && B[k]) {
      if (JSON.stringify(A[k]) === JSON.stringify(B[k])) out.push({ k: "same", r: B[k] });
      else { out.push({ k: "del", r: A[k] }); out.push({ k: "add", r: B[k] }); }
    } else if (A[k]) out.push({ k: "del", r: A[k] });
    else out.push({ k: "add", r: B[k] });
  });
  return out;
}

/* ---------- Sources ---------- */
export function sources(spec: Spec): { item: ItemId; path: string; source: Source }[] {
  const out: { item: ItemId; path: string; source: Source }[] = [];
  const add = (it: ItemId, path: string, s?: Sources) => srcList(s).forEach((x, i, all) => out.push({ item: it, path: path + (all.length > 1 ? "#" + (i + 1) : ""), source: x }));
  add(item.scope, "scope", spec.scope.source);
  spec.questions.forEach(q => add(item.q(q.id), "questions." + q.id, q.source));
  spec.derived.forEach(d => add(item.d(d.id), "derived." + d.id, d.source));
  spec.outcomes.forEach(o => {
    add(item.out(o.id), "outcomes." + o.id, o.source);
    o.actions.forEach((a, i) => add(item.out(o.id), "outcomes." + o.id + ".actions[" + i + "]", a.source));
    add(item.fu(o.id), "outcomes." + o.id + ".follow_up", o.follow_up?.source);
  });
  spec.rules.forEach(r => add(item.rule(r.id), "rules." + r.id, r.source));
  spec.open_questions.forEach(q => add(item.scope, "open_questions." + q.id, q.source));
  return out;
}

/* ---------- Numeric literals (thresholds) ---------- */
export interface Literal { item: ItemId; path: Path; leaf: Leaf; context: Cond | null }
/** Every number in a derived definition or a rule condition, with the path to edit it. */
export function literals(spec: Spec): Literal[] {
  const out: Literal[] = [];
  spec.derived.forEach(d => leaves(d.definition, ["derived", d.id, "definition"]).forEach(l => { if (l.leaf.value !== undefined) out.push({ item: item.d(d.id), path: [...l.path, "value"], leaf: l.leaf, context: l.parent }); }));
  spec.rules.forEach(r => { if (r.when !== "otherwise") leaves(r.when, ["rules", r.id, "when"]).forEach(l => { if (l.leaf.value !== undefined) out.push({ item: item.rule(r.id), path: [...l.path, "value"], leaf: l.leaf, context: l.parent }); }); });
  return out;
}

/* ---------- Test generation ---------- */
/** Values either side of every threshold a question is compared with, inside its entry limits. */
export function boundaryValues(spec: Spec): Record<string, (boolean | number)[]> {
  const out: Record<string, (boolean | number)[]> = {};
  const all: Leaf[] = [];
  spec.derived.forEach(d => all.push(...leaves(d.definition).map(l => l.leaf)));
  spec.rules.forEach(r => { if (r.when !== "otherwise") all.push(...leaves(r.when).map(l => l.leaf)); });
  spec.questions.forEach(q => { if (q.shown_when) all.push(...leaves(q.shown_when).map(l => l.leaf)); });
  for (const q of spec.questions) {
    if (q.answer_type === "yes_no") { out[q.id] = [false, true]; continue; }
    const v = new Set<number>();
    all.filter(l => l.field === q.id && l.value !== undefined).forEach(l => {
      const n = l.value!;
      if (l.op === "at_least" || l.op === "less_than") { v.add(n - 1); v.add(n); }
      else if (l.op === "at_most" || l.op === "greater_than") { v.add(n); v.add(n + 1); }
      else { v.add(n - 1); v.add(n); v.add(n + 1); }
    });
    const lo = q.constraint?.min, hi = q.constraint?.max;
    if (lo !== undefined) v.add(lo);
    if (hi !== undefined) v.add(hi);
    if (!v.size) v.add(lo ?? 0);
    out[q.id] = [...v].filter(n => (lo === undefined || n >= lo) && (hi === undefined || n <= hi)).sort((a, b) => a - b);
  }
  return out;
}

/** Synthetic patients: every combination of boundary values (sampled evenly above `cap`), hidden answers blanked, de-duplicated. */
export function patients(spec: Spec, cap = 20000): Answers[] {
  const qs = byOrder(spec), vals = boundaryValues(spec);
  const radix = qs.map(q => vals[q.id].length);
  const total = radix.reduce((a, b) => a * b, 1);
  const stride = Math.max(1, Math.ceil(total / cap));
  const seen = new Set<string>(), out: Answers[] = [];
  for (let k = 0; k < total; k += stride) {
    let n = k;
    const a: Answers = {};
    qs.forEach((q, i) => { a[q.id] = vals[q.id][n % radix[i]]; n = Math.floor(n / radix[i]); });
    const v = visibleAnswers(spec, a), key = JSON.stringify(v);
    if (!seen.has(key)) { seen.add(key); out.push(v); }
  }
  return out;
}

/** One mutant per threshold (value + 1). A good test set tells each mutant apart from the original. */
export function mutationScore(spec: Spec, ps: Answers[]): { killed: number; total: number } {
  const base = ps.map(p => evaluate(spec, p).outcome);
  const ms = literals(spec).map(l => applyPatch(spec, { op: "set", path: l.path, value: l.leaf.value! + 1 }));
  const killed = ms.filter(m => ps.some((p, i) => evaluate(m, p).outcome !== base[i])).length;
  return { killed, total: ms.length };
}
