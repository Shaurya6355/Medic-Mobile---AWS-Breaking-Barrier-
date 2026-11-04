/* Read-only views of the logic model for the UI: items, facts, editable slots, checks. Deterministic, no AI.
   All semantics (types, evaluation, compile) come from the shared pathway compiler. */
import {
  evaluate, humanize, item, literals, srcList, patients, print, splitItem, toGraph, usedFields, refs,
  type Answers, type Cond, type ItemId, type Literal, type Path, type Question, type Spec,
} from "../../../shared/pathway/index.ts";
import { DRAFT, GOLDEN, V3, same } from "./data";
import type { Check, Classification } from "./types";

/* ---------- Lookups ---------- */
export const getQ = (m: Spec, id: string) => m.questions.find(q => q.id === id);
export const getD = (m: Spec, id: string) => m.derived.find(d => d.id === id);
export const getR = (m: Spec, id: string) => m.rules.find(r => r.id === id);
export const getO = (m: Spec, id: string) => m.outcomes.find(o => o.id === id);
export const anyQ = (q: string): Question | null => getQ(V3, q) || getQ(DRAFT, q) || null;

/** Every reviewable item across the given versions, in a stable order. */
export function allItems(...ms: Spec[]): ItemId[] {
  const s = new Set<ItemId>([item.scope]);
  ms.forEach(m => m.rules.slice().sort((a, b) => a.priority - b.priority).forEach(r => s.add(item.rule(r.id))));
  ms.forEach(m => m.outcomes.forEach(o => { s.add(item.out(o.id)); if (o.follow_up) s.add(item.fu(o.id)); }));
  ms.forEach(m => m.derived.forEach(d => s.add(item.d(d.id))));
  ms.forEach(m => m.questions.slice().sort((a, b) => a.order - b.order).forEach(q => s.add(item.q(q.id))));
  return [...s];
}
/** Items drawn as boxes in the flow chart. Questions and derived values sit below it. */
export const flowItems = (m: Spec): ItemId[] => toGraph(m).nodes.map(n => n.id);

/* ---------- Names ---------- */
const words = (id: string) => id.replace(/_/g, " ");
export function fieldName(m: Spec, f: string): string {
  const d = getD(m, f);
  return d ? d.label.toLowerCase() : words(f);
}
const UNIT: Record<string, string> = { months: "months", days: "days", breaths_per_minute: "/min" };
export const fieldUnit = (m: Spec, f: string) => { const u = getQ(m, f)?.unit; return u ? UNIT[u] ?? words(u) : ""; };
export const condText = (m: Spec, c: Cond) => humanize(c, f => fieldName(m, f), f => fieldUnit(m, f));

/* ---------- Usage ---------- */
/** Questions an item depends on (through derived values too). */
export function usesOf(m: Spec, id: ItemId): string[] {
  const [k, key] = splitItem(id);
  let c: Cond | null = null;
  if (k === "rule") { const w = getR(m, key)?.when; c = w && w !== "otherwise" ? w : null; }
  if (k === "d") c = getD(m, key)?.definition ?? null;
  if (!c) return [];
  const out = new Set<string>(), seen = new Set<string>();
  const visit = (f: string) => {
    if (seen.has(f)) return; seen.add(f);
    const d = getD(m, f);
    if (d) refs(d.definition).forEach(visit); else if (getQ(m, f)) out.add(f);
  };
  refs(c).forEach(visit);
  return [...out].sort((a, b) => getQ(m, a)!.order - getQ(m, b)!.order);
}

export type QStatus = "added" | "removed" | "same" | "changed" | "none";
export function qStatus(m: Spec, q: string, ref: Spec = V3): QStatus {
  const a = getQ(m, q), b = getQ(ref, q);
  if (!b && a) return "added";
  if (!a) return anyQ(q) ? "removed" : "none";
  return same(a, b) ? "same" : "changed";
}
/** Questions no rule uses (directly, via a derived value, or by gating one that is used), plus questions removed relative to v3 or the draft. */
export function trayIds(m: Spec): string[] {
  const used = usedFields(m);
  const gate = (q: string) => m.questions.some(o => o.shown_when && refs(o.shown_when).includes(q) && used.has(o.id));
  const ids = new Set<string>();
  m.questions.forEach(q => { if (!used.has(q.id) && !gate(q.id)) ids.add(q.id); });
  [...V3.questions, ...DRAFT.questions].forEach(q => { if (!getQ(m, q.id)) ids.add(q.id); });
  return [...ids];
}

/* ---------- Signatures (what "changed" means) ---------- */
export function nodeSig(m: Spec, id: ItemId): string {
  const [k, key] = splitItem(id);
  switch (k) {
    case "scope": return JSON.stringify(m.scope);
    case "q": return JSON.stringify(getQ(m, key) ?? null);
    case "d": return JSON.stringify(getD(m, key) ?? null);
    case "rule": return JSON.stringify(getR(m, key) ?? null);
    case "out": { const o = getO(m, key); return JSON.stringify(o ? { ...o, follow_up: undefined } : null); }
    case "fu": return JSON.stringify(getO(m, key)?.follow_up ?? null);
  }
  return "";
}
export const changedVs = (m: Spec, id: ItemId, ref: Spec = V3) => nodeSig(m, id) !== nodeSig(ref, id);

/* ---------- Facts (read-only view) ---------- */
export function facts(m: Spec, id: ItemId): [string, string][] {
  const [k, key] = splitItem(id);
  switch (k) {
    case "scope": return [
      ["Applies to", "Children " + m.scope.age_months_min + " months up to " + m.scope.age_months_below + " months (not included)"],
      ["Left out", m.scope.excluded.map(e => e.item).join("; ") || "nothing"],
    ];
    case "q": {
      const q = getQ(m, key);
      if (!q) return [["Question", anyQ(key) ? anyQ(key)!.label + " (removed)" : "(not in this version)"]];
      const c = q.constraint;
      const f: [string, string][] = [["Question", q.label], ["Type", q.answer_type === "yes_no" ? "yes/no" : "integer" + (q.unit ? " (" + words(q.unit) + ")" : "")], ["Shown when", q.shown_when ? print(q.shown_when) : "always"]];
      if (c && (c.min !== undefined || c.max !== undefined)) f.push(["Entry limits", (c.min ?? "-") + " to " + (c.max ?? "-")]);
      return f;
    }
    case "d": {
      const d = getD(m, key);
      return d ? [["Value", d.label], ["Yes when", print(d.definition)]] : [["Value", "(not in this version)"]];
    }
    case "rule": {
      const r = getR(m, key);
      if (!r) return [["Rule", "(not in this version)"]];
      return [["Priority", String(r.priority)], ["If", r.when === "otherwise" ? "otherwise (no earlier rule matched)" : print(r.when)], ["Then", getO(m, r.outcome)?.title ?? r.outcome]];
    }
    case "out": {
      const o = getO(m, key);
      if (!o) return [["Classification", "(not in this version)"]];
      const f: [string, string][] = [["Classification", o.title], ["Severity", String(o.severity)]];
      o.actions.forEach((a, i) => {
        f.push(["Action " + (i + 1), a.text]);
        (a.dose_by_age || []).forEach(r => f.push(["Dose, " + r.age_months_min + " to " + r.age_months_below + " months", r.dose + (r.total ? " (" + r.total + " in total)" : "")]));
      });
      return f;
    }
    case "fu": {
      const f = getO(m, key)?.follow_up;
      if (!f) return [["Follow-up", "none"]];
      return [["Kind", f.kind === "scheduled" ? "scheduled visit" : "on return"], ["Due", f.due_in_days === null ? "not set" : "day " + f.due_in_days], ["Task stays open", f.task_window_days_after_due === null ? "not set" : f.task_window_days_after_due + " days after due"]];
    }
  }
  return [];
}

/* ---------- Editable slots (what the editor shows and AI revisions target) ---------- */
export type SlotKind = "text" | "area" | "number" | "numberOrNull" | "cond" | "outcome";
export interface Slot { key: string; label: string; path: Path; kind: SlotKind; value: unknown; help?: string; optional?: boolean }

function litLabel(l: Literal): string {
  const sym: Record<string, string> = { at_least: ">=", at_most: "<=", less_than: "<", greater_than: ">", equals: "=" };
  const others = l.context && "all" in l.context ? l.context.all.filter(x => x !== l.leaf) : [];
  return l.leaf.field + " " + sym[l.leaf.op] + (others.length ? " (when " + print({ all: others }) + ")" : "");
}
export function slots(m: Spec, id: ItemId): Slot[] {
  const [k, key] = splitItem(id);
  const lits = () => literals(m).filter(l => l.item === id).map((l, i): Slot => ({ key: "lit" + i, label: litLabel(l), path: l.path, kind: "number", value: l.leaf.value }));
  switch (k) {
    case "scope": return [
      { key: "min", label: "Youngest age (months)", path: ["scope", "age_months_min"], kind: "number", value: m.scope.age_months_min },
      { key: "below", label: "Up to age (months, not included)", path: ["scope", "age_months_below"], kind: "number", value: m.scope.age_months_below },
    ];
    case "q": {
      const q = getQ(m, key);
      if (!q) return [];
      const s: Slot[] = [
        { key: "label", label: "Question label", path: ["questions", key, "label"], kind: "text", value: q.label },
        { key: "show", label: "Shown when", path: ["questions", key, "shown_when"], kind: "cond", value: q.shown_when, optional: true, help: "Empty = always. For example: cough is yes" },
      ];
      if (q.answer_type === "integer") {
        s.push({ key: "min", label: "Entry limit, lowest", path: ["questions", key, "constraint", "min"], kind: "number", value: q.constraint?.min });
        s.push({ key: "max", label: "Entry limit, highest", path: ["questions", key, "constraint", "max"], kind: "number", value: q.constraint?.max });
      }
      return s;
    }
    case "d": {
      const d = getD(m, key);
      if (!d) return [];
      return [
        { key: "label", label: "Name", path: ["derived", key, "label"], kind: "text", value: d.label },
        { key: "def", label: "Yes when", path: ["derived", key, "definition"], kind: "cond", value: d.definition, help: "Use and, or, not, brackets; is yes / is no; >= <= < > =" },
        ...lits(),
      ];
    }
    case "rule": {
      const r = getR(m, key);
      if (!r) return [];
      return [
        ...(r.when === "otherwise" ? [] : [{ key: "when", label: "If", path: ["rules", key, "when"], kind: "cond" as const, value: r.when, help: "Rules are tried in priority order; the first that matches decides." }]),
        { key: "out", label: "Then", path: ["rules", key, "outcome"], kind: "outcome", value: r.outcome },
        ...lits(),
      ];
    }
    case "out": {
      const o = getO(m, key);
      if (!o) return [];
      const s: Slot[] = [{ key: "title", label: "Classification name", path: ["outcomes", key, "title"], kind: "text", value: o.title }];
      o.actions.forEach((a, i) => {
        s.push({ key: "a" + i, label: "Action " + (i + 1) + " (shown to the CHW)", path: ["outcomes", key, "actions", i, "text"], kind: "area", value: a.text, help: i ? undefined : "Clinical text: the clinician sees every change." });
        (a.dose_by_age || []).forEach((r, j) => s.push({ key: "a" + i + "d" + j, label: "Dose, " + r.age_months_min + " to " + r.age_months_below + " months", path: ["outcomes", key, "actions", i, "dose_by_age", j, "dose"], kind: "text", value: r.dose }));
      });
      return s;
    }
    case "fu": {
      const f = getO(m, key)?.follow_up;
      if (!f) return [];
      return [
        { key: "due", label: "Due on day", path: ["outcomes", key, "follow_up", "due_in_days"], kind: "numberOrNull", value: f.due_in_days },
        { key: "win", label: "Task stays open (days after due)", path: ["outcomes", key, "follow_up", "task_window_days_after_due"], kind: "numberOrNull", value: f.task_window_days_after_due },
      ];
    }
  }
  return [];
}

/* ---------- Running the rules ---------- */
export function classify(m: Spec, a: Answers): Classification {
  const r = evaluate(m, a);
  return { out: r.outcome, rule: r.rule };
}
export function golden(m: Spec) {
  return (GOLDEN[m.meta.pathway_id] || []).map(([id, a, exp]) => { const r = classify(m, a); return { id, a, exp, got: r.out, rule: r.rule, ok: r.out === exp }; });
}
const SHORT: Record<string, string> = { months: " mo", days: " d", breaths_per_minute: "/min" };
export function describeP(m: Spec, a: Answers): string {
  const nums: string[] = [], yes: string[] = [];
  m.questions.slice().sort((x, y) => x.order - y.order).forEach(q => {
    const v = a[q.id];
    if (v === null || v === undefined) return;
    if (q.answer_type === "integer") nums.push(v + (q.unit ? SHORT[q.unit] ?? " " + q.unit : ""));
    else if (v === true) yes.push(words(q.id));
  });
  return nums.concat(yes.length ? yes.join(", ") : "no signs").join(", ");
}
export const outName = (m: Spec, o: string | null) => (o === null ? "No outcome" : getO(m, o)?.title ?? o);

/** Synthetic patients, cached per model. */
const cache = new WeakMap<Spec, Answers[]>();
export function grid(m: Spec): Answers[] {
  let g = cache.get(m);
  if (!g) { g = patients(m); cache.set(m, g); }
  return g;
}

/* ---------- Titles and sources ---------- */
export function nodeTitle(id: ItemId): string {
  const [k, key] = splitItem(id);
  switch (k) {
    case "scope": return "Applies to";
    case "q": return "Question · " + key;
    case "d": return "Derived value · " + key;
    case "rule": return "Rule " + key;
    case "out": return "Classification · " + words(key);
    case "fu": return "Follow-up task · " + words(key);
  }
  return id;
}
export function itemLabel(id: ItemId): string {
  if (id.startsWith("F-")) return "Question " + id.slice(2);
  const [k, key] = splitItem(id);
  return k === "scope" ? "Applies to" : k === "rule" ? "Rule " + key : k === "q" ? "Question " + key : words(key);
}
export function srcOf(m: Spec, id: ItemId): [quote: string, where: string] {
  const [k, key] = splitItem(id);
  const x = k === "scope" ? m.scope : k === "q" ? getQ(m, key) || anyQ(key) : k === "d" ? getD(m, key) : k === "rule" ? getR(m, key) : k === "out" ? getO(m, key) : k === "fu" ? getO(m, key)?.follow_up : null;
  if (!x) return ["(no quote)", "-"];
  const ss = "source" in x ? srcList(x.source) : [];
  if (ss.length) return [ss.map(s => s.quote).join(" … "), ss.map(s => "page " + s.page).join(", ")];
  return ["Team decision: no guideline quote.", "origin: " + ("origin" in x ? x.origin : "team")];
}

/** Checks and open flags that touch any of the given items: what the rule table shows on each row. */
export function rowIssues(checks: Check[], flags: { id: string; about: ItemId; res?: unknown; title: string }[], ids: ItemId[]) {
  const cs = checks.filter(c => ids.includes(c.id));
  const fs = flags.filter(f => !f.res && ids.includes(f.about));
  const status: "edit" | "check" | "ok" = cs.some(c => c.sev === "blocking") ? "edit" : cs.length || fs.length ? "check" : "ok";
  return { checks: cs, flags: fs, status };
}

/** Strip references to internal documents (BRD, PRD, spec ids) from text shown to users. */
export const clean = (t: string) => t.replace(/\s*\((?:BRD|PRD|SRS|FRD|internal)\b[^)]*\)/gi, "").replace(/\s+([.,;:?])/g, "$1").trim();

/** Flow boxes to zoom to for a step: the box and its neighbours, or for a question or derived value the rules that read it. */
export function relatedFlowIds(m: Spec, id: ItemId): ItemId[] {
  const g = toGraph(m);
  const nodes = new Set(g.nodes.map(n => n.id));
  const [k, key] = splitItem(id);
  let core: ItemId[] = [];
  if (nodes.has(id)) core = [id];
  else if (k === "q" || k === "d") core = m.rules.filter(r => usesOf(m, item.rule(r.id)).includes(key) || (r.when !== "otherwise" && reads(m, r.when, key))).map(r => item.rule(r.id));
  if (!core.length || id === item.scope) return [];
  const out = new Set(core);
  g.edges.forEach(e => { if (core.includes(e.from)) out.add(e.to); if (core.includes(e.to)) out.add(e.from); });
  return [...out];
}
function reads(m: Spec, c: Cond, f: string): boolean {
  return refs(c).some(r => r === f || (!!getD(m, r) && reads(m, getD(m, r)!.definition, f)));
}

