/* Interpreter, checks and read-only descriptions of the logic model. Deterministic, no AI. */
import { COND, GOLDEN, GRID, NODE_IDS, QORDER, QTYPE, SIGNS, SRC_NUMS, V3, AI_DRAFT, same } from "./data";
import type { Check, Classification, ItemId, Model, NodeId, OutKey, PatientInputs, Question } from "./types";

export const isNode = (id: ItemId): id is NodeId => (NODE_IDS as string[]).includes(id);

export function usesOf(m: Model, id: ItemId): string[] {
  if (id === "start") return ["cough", "age_months"];
  if (id === "d1") return ["danger_signs"];
  if (id === "d2" || id === "d3") {
    const s: string[] = [];
    m[id].conds.forEach(c => {
      if (c === "ci") s.push("chest_indrawing");
      if (c === "stridor") s.push("stridor");
      if (c === "fast") s.push("resp_rate", "age_months");
    });
    return [...new Set(s)].filter(q => m.questions[q]);
  }
  return [];
}
export function usedSet(m: Model): Set<string> {
  const s = new Set<string>();
  (["start", "d1", "d2", "d3"] as NodeId[]).forEach(id => usesOf(m, id).forEach(q => s.add(q)));
  return s;
}
export const anyQ = (q: string): Question | null => V3.questions[q] || AI_DRAFT.questions[q] || null;
export const questionOrder = (m: Model) => QORDER.concat(Object.keys(m.questions).filter(q => !QORDER.includes(q)));

export type QStatus = "added" | "removed" | "same" | "changed" | "none";
export function qStatus(m: Model, q: string, ref: Model = V3): QStatus {
  if (!ref.questions[q] && m.questions[q]) return "added";
  if (!m.questions[q]) return anyQ(q) ? "removed" : "none";
  return same(m.questions[q], ref.questions[q]) ? "same" : "changed";
}
/** Questions no rule uses, plus questions removed relative to v3 or the AI draft. */
export function trayIds(m: Model): string[] {
  const used = usedSet(m);
  const all = { ...V3.questions, ...AI_DRAFT.questions };
  return questionOrder(m).filter(q => (m.questions[q] && !used.has(q)) || (all[q] && !m.questions[q]));
}
export function nodeSig(m: Model, id: ItemId): string {
  if (id.startsWith("q:")) return JSON.stringify(m.questions[id.slice(2)] || null);
  if (!isNode(id)) return "";
  return JSON.stringify([m[id], m.src[id], usesOf(m, id).map(q => m.questions[q])]);
}
export const changedVs = (m: Model, id: ItemId, ref: Model = V3) => nodeSig(m, id) !== nodeSig(ref, id);

export function facts(m: Model, id: ItemId): [string, string][] {
  if (id.startsWith("q:")) {
    const k = id.slice(2), q = m.questions[k];
    if (!q) return [["Question", anyQ(k) ? anyQ(k)!.label + " (removed)" : "(not in this version)"]];
    return [["Question", q.label], ["Type", QTYPE[q.type]], ["Shown when", q.showIf || "always"]];
  }
  switch (id) {
    case "start": return [["Applies to", "Children " + m.start.ageMin + " months up to " + m.start.ageMax + " months (not included)"]];
    case "d1": return [["Question", m.d1.q], ["Yes if any of", m.d1.signs.map(s => SIGNS[s]).join(", ") || "none"]];
    case "d2": case "d3": {
      const v = m[id];
      const f: [string, string][] = [["Question", v.q], ["Yes if any of", v.conds.map(c => COND[c]).join(", ") || "none"]];
      if (id === "d3" && v.conds.includes("fast")) f.push(["Fast breathing", m.d3.young + "/min or more under " + m.d3.cut + " months; " + m.d3.old + "/min or more after"]);
      f.push(["Note under the question", v.hint || "none"]);
      return f;
    }
    case "f1": return [["Task", m.f1.title], ["Due", "day " + m.f1.due], ["Open until", "day " + m.f1.end]];
    case "o1": case "o2": case "o3": return [["Classification", m[id].title], ["Note shown to the CHW", m[id].note]];
  }
  return [];
}

/** The only place outcomes are computed. */
export function classify(m: Model, p: PatientInputs): Classification {
  if (p.age < m.start.ageMin || p.age >= m.start.ageMax) return { out: "none", rule: "start" };
  if (p.danger.some(d => m.d1.signs.includes(d))) return { out: "o1", rule: "d1" };
  const fast = p.age < m.d3.cut ? p.rr >= m.d3.young : p.rr >= m.d3.old;
  const val = { ci: p.ci, stridor: p.stridor, fast };
  if (m.d2.conds.some(c => val[c])) return { out: "o1", rule: "d2" };
  if (m.d3.conds.some(c => val[c])) return { out: "o2", rule: "d3" };
  return { out: "o3", rule: "o3" };
}
export function golden(m: Model) {
  return GOLDEN.map(([id, p, exp]) => { const r = classify(m, p); return { id, p, exp, got: r.out, ok: r.out === exp }; });
}
export function describeP(p: PatientInputs): string {
  const s: string[] = [];
  if (p.ci) s.push("chest indrawing");
  if (p.stridor) s.push("stridor");
  if (p.danger.length) s.push("convulsions");
  return s.length ? s.join(", ") : "no signs";
}
export const outName = (m: Model, o: OutKey | "none") => (o === "none" ? "Out of range" : m[o].title);

/** Same checks for AI drafts, PO edits and accepted AI revisions. */
export function runChecks(m: Model): Check[] {
  const out: Check[] = [];
  const add = (sev: Check["sev"], id: ItemId, text: string) => out.push({ sev, id, text });
  (["d2", "d3"] as const).forEach(id => { if (!m[id].conds.length) add("blocking", id, "No condition set, so its Yes branch can never be reached."); });
  if (!m.d1.signs.length) add("blocking", "d1", "No danger signs selected: this branch is unreachable.");
  if (m.f1.end < m.f1.due) add("blocking", "f1", "The task closes before it is due.");
  if (m.start.ageMin >= m.start.ageMax) add("blocking", "start", "The age range is empty.");
  Object.keys(m.questions).forEach(q => { if (!m.questions[q].label.trim()) add("blocking", "q:" + q, "Question has no label."); });
  const fired = new Set(GRID.map(p => classify(m, p).rule));
  if (m.d1.signs.length && !fired.has("d1")) add("blocking", "d1", "No patient ever reaches this rule: an earlier rule always fires first.");
  (["d2", "d3"] as const).forEach(id => { if (m[id].conds.length && !fired.has(id)) add("blocking", id, "No patient ever reaches this rule: an earlier rule always fires first."); });
  const nums: [NodeId, number][] = [["d3", m.d3.young], ["d3", m.d3.old], ["d3", m.d3.cut], ["f1", m.f1.due], ["f1", m.f1.end], ["start", m.start.ageMin], ["start", m.start.ageMax]];
  nums.forEach(([id, n]) => { if (!SRC_NUMS.includes(Number(n))) add("warning", id, "The number " + n + " is not in the cited passage."); });
  if (m.d3.conds.includes("fast") && m.d3.young < m.d3.old) add("warning", "d3", "Younger children have the lower threshold; the guideline has it the other way round.");
  const used = usedSet(m);
  Object.keys(m.questions).forEach(q => { if (!used.has(q)) add("warning", "q:" + q, "Asked on the form but no rule uses it."); });
  golden(m).filter(g => !g.ok).forEach(g => {
    const rule = classify(m, g.p).rule;
    add("blocking", rule === "o3" ? "d3" : rule, "Golden case " + g.id + " (" + g.p.age + " mo, " + g.p.rr + "/min, " + describeP(g.p) + ") expected " + m[g.exp].title + ", got " + outName(m, g.got) + ".");
  });
  return out;
}

export function nodeTitle(id: ItemId): string {
  if (id.startsWith("q:")) return "Question · " + id.slice(2);
  const t: Record<NodeId, string> = { start: "Applies to", d1: "Question · danger signs", d2: "Question · severe signs", d3: "Question · pneumonia signs", o1: "Classification · severe", o2: "Classification · pneumonia", o3: "Classification · no pneumonia", f1: "Follow-up task" };
  return isNode(id) ? t[id] : id;
}
export function itemLabel(id: ItemId): string {
  if (id.startsWith("F-")) return "Flag " + id;
  if (id.startsWith("q:")) return "Question " + id.slice(2);
  return nodeTitle(id).replace("Question · ", "").replace("Classification · ", "");
}
export function srcOf(m: Model, id: ItemId): [string, string] {
  if (id.startsWith("q:")) { const q = m.questions[id.slice(2)] || anyQ(id.slice(2)); return q ? [q.quote, "question"] : ["(no quote)", "-"]; }
  return isNode(id) ? m.src[id] : ["(no quote)", "-"];
}
