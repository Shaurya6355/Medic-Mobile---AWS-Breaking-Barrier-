/* The AI agent: what the program officer used to do.
   1. agentPass: runs checks 1 to 3 on the draft and fixes what is safe to fix in code (a quote cited on the
      wrong page, rule priorities with gaps). Anything clinical stays with the clinician.
   2. respond: the assistant in the clinician's chat. Deterministic intent handling over the logic model for now
      (what-if patients, explain a rule, propose a threshold change with its impact, summarise checks);
      the seam where a Bedrock call goes later. It never changes the model itself: changes are proposals. */
import { applyPatch, item, literals, quoteResults, srcList, type Answers, type ItemId, type Leaf, type Path, type Spec } from "../../../shared/pathway/index.ts";
import { checkStages } from "./checks";
import { classify, condText, describeP, fieldName, getD, getO, getR, golden, grid, outName } from "./logic";
import type { AgentFix, ChatMsg, Check, Evidence, Patch, Proposal, Workflow } from "./types";

type Msg = Omit<ChatMsg, "id">;

/* ---------- 1. The agent's pass ---------- */
/** "outcomes.x.actions[0]#2" -> ["outcomes", "x", "actions", 0, "source", 1] */
function sourcePath(p: string): Path {
  const [base, n] = p.split("#");
  const out: Path = [];
  base.split(".").forEach(seg => { const m = seg.match(/^(.+)\[(\d+)\]$/); if (m) out.push(m[1], Number(m[2])); else out.push(seg); });
  out.push("source");
  if (n) out.push(Number(n) - 1);
  return out;
}

export function agentPass(m: Spec, ev: Evidence, quiet = false): { model: Spec; fixes: AgentFix[] } {
  let x = m;
  const fixes: AgentFix[] = [];
  // Rule priorities: keep the order, close gaps and duplicates.
  const byP = x.rules.slice().sort((a, b) => a.priority - b.priority);
  if (byP.some((r, i) => r.priority !== i + 1)) {
    x = applyPatch(x, { op: "set", path: ["rules"], value: byP.map((r, i) => ({ ...r, priority: i + 1 })) });
    fixes.push({ item: item.rule(byP[0].id), check: "schema", text: "Rule priorities had gaps or repeats. Renumbered 1 to " + byP.length + ", same order." });
  }
  // A quote found on exactly one other page: correct the page number.
  if (ev.pages) quoteResults(x, ev.pages).filter(r => r.found && !r.onPage && r.foundOn.length === 1).forEach(r => {
    x = applyPatch(x, { op: "set", path: sourcePath(r.path), value: { ...r.source, page: r.foundOn[0] } });
    fixes.push({ item: r.item, check: "quote", text: "Quote cited page " + r.source.page + " but is on page " + r.foundOn[0] + ". Corrected the page." });
  });
  return { model: x, fixes: quiet ? [] : fixes };
}

/* ---------- 2. The assistant ---------- */
const plural = (n: number, w: string) => n + " " + w + (n === 1 ? "" : "s");

export function intro(w: Workflow, checks: Check[]): Msg[] {
  const st = checkStages(w.model, w.evidence);
  const line = (k: string) => { const s = st.find(x => x.key === k)!; return s.n + " " + s.name + ": " + s.summary + "."; };
  const fixes = w.agent.length ? "I fixed " + plural(w.agent.length, "thing") + " on my own: " + w.agent.map(f => f.text).join(" ") : "Nothing needed fixing.";
  const blocking = checks.filter(c => c.sev === "blocking").length;
  const out: Msg[] = [
    { from: "agent", text: "I checked the draft before handing it to you. " + ["schema", "quote", "number", "logic"].map(line).join(" ") + " " + fixes },
    { from: "agent", text: line("golden") + " " + line("cross") + (blocking ? " " + plural(blocking, "blocking problem") + " left: see the checks at the top." : "") },
  ];
  if (w.flags.length) {
    out.push({ from: "agent", text: "The guideline leaves " + plural(w.flags.length, "question") + " open. Only you can answer these. Keep the draft's choice, or change it in the Edit tab." });
    w.flags.forEach(f => out.push({ from: "agent", text: f.title, ask: f.id, select: f.about }));
  }
  out.push({ from: "agent", text: "Ask me anything, for example: \"what happens to a 2 year old breathing 45 a minute?\", \"explain R3\", or \"change 40 to 45\"." });
  return out;
}

const STOP = new Set(["not", "able", "the", "child", "everything", "unusually", "any", "does", "have", "has"]);
const stems = (id: string) => id.split("_").filter(t => t.length >= 4 && !STOP.has(t)).map(t => t.slice(0, 5));
const toks = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);

/** A patient described in words: "2 year old, breathing 45 a minute, no convulsions". */
function patientFrom(m: Spec, text: string): { a: Answers; told: string[]; assumed: string[] } | null {
  const t = text.toLowerCase(), a: Answers = {}, told: string[] = [], assumed: string[] = [];
  let used = t;
  const take = (re: RegExp) => { const x = used.match(re); if (x) used = used.replace(x[0], " "); return x; };
  m.questions.filter(q => q.answer_type === "integer").forEach(q => {
    let x: RegExpMatchArray | null = null, v = NaN;
    if (q.unit === "months") {
      x = take(/(\d+(?:\.\d+)?)\s*-?\s*(months?|mo\b|mths?|years?|yrs?|y\/?o\b)/);
      if (x) v = Math.round(Number(x[1]) * (/^(y|yr)/.test(x[2]) ? 12 : 1));
    } else if (q.unit === "breaths_per_minute") {
      x = take(/(\d+)\s*(?:breaths?|bpm|\/\s*min|per minute|a minute)/) || take(/breath\w*\s+(?:at\s+|of\s+|rate\s+(?:of\s+)?)?(\d+)/);
      if (x) v = Number(x[1]);
    } else if (q.unit === "days") {
      x = take(/(\d+)\s*days?/) || take(/(\d+)\s*weeks?/);
      if (x) v = Number(x[1]) * (/week/.test(x[0]) ? 7 : 1);
    }
    if (!isNaN(v)) { a[q.id] = v; told.push(q.unit === "months" ? v + " months old" : q.unit === "breaths_per_minute" ? v + " breaths a minute" : q.unit === "days" ? "cough for " + v + " days" : fieldName(m, q.id) + " " + v); }
  });
  m.questions.filter(q => q.answer_type === "yes_no").forEach(q => {
    const st = stems(q.id);
    const hit = st.map(s => t.search(new RegExp("\\b" + s))).find(i => i >= 0);
    if (hit === undefined) return;
    const before = t.slice(Math.max(0, hit - 14), hit);
    const yes = !/\b(no|without|not|n't|denies)\b[^,.;]*$/.test(before);
    a[q.id] = yes; told.push((yes ? "" : "no ") + fieldName(m, q.id));
  });
  if (!told.length) return null;
  const cough = m.questions.find(q => q.id === "cough");
  if (cough && a.cough === undefined) { a.cough = true; assumed.push("has a cough"); }
  return { a, told, assumed };
}

function explainRule(m: Spec, id: string): Msg {
  const r = getR(m, id)!, o = getO(m, r.outcome);
  const src = srcList(r.source)[0];
  const when = r.when === "otherwise" ? "no earlier rule matched" : condText(m, r.when);
  return {
    from: "agent", select: item.rule(r.id),
    text: "Rule " + r.id + " is tried " + ordinal(r.priority) + ". If " + when + ", the child is classified \"" + (o?.title ?? r.outcome) + "\"."
      + (o?.actions.length ? " The health worker: " + o.actions.map(x => x.text).join(" ") : "")
      + (src ? " Source, page " + src.page + ": \"" + src.quote + "\"" : " This rule is a team decision, not from the guideline."),
  };
}
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

/** Every number the clinician could mean, with the path to change it. */
function numberSlots(m: Spec) {
  const out: { item: ItemId; path: Path; value: number; desc: string; field: string; leaf: Leaf; ctx: string }[] = [];
  literals(m).forEach(l => out.push({ item: l.item, path: l.path, value: l.leaf.value!, field: "value", leaf: l.leaf, desc: condText(m, l.context ?? l.leaf), ctx: l.context ? condText(m, l.context) : "" }));
  m.outcomes.forEach(o => { if (typeof o.follow_up?.due_in_days === "number") out.push({ item: item.fu(o.id), path: ["outcomes", o.id, "follow_up", "due_in_days"], value: o.follow_up.due_in_days, field: "due", leaf: { field: "follow_up", op: "equals", value: o.follow_up.due_in_days }, desc: "follow-up due on day " + o.follow_up.due_in_days + " for \"" + o.title + "\"", ctx: "" }); });
  return out;
}

export function impact(m: Spec, patch: Patch): string {
  const x = applyPatch(m, patch), ps = grid(m);
  const moved = ps.filter(p => classify(m, p).out !== classify(x, p).out).length;
  const g0 = golden(m), g1 = golden(x);
  const broke = g1.filter((g, i) => !g.ok && g0[i].ok), fixed = g1.filter((g, i) => g.ok && !g0[i].ok);
  return "Changes the result for " + moved + " of " + ps.length + " sample patients. Test patients: " + g1.filter(g => g.ok).length + " of " + g1.length + " get the expected result"
    + (broke.length ? "; " + broke.map(g => g.id + " would get \"" + outName(x, g.got) + "\"").join(", ") : "")
    + (fixed.length ? "; now passing: " + fixed.map(g => g.id).join(", ") : "") + ".";
}

function proposeNumber(m: Spec, text: string): Msg | null {
  const t = text.toLowerCase();
  const pair = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:->|→|to|into)\s*(\d+(?:\.\d+)?)(?!\s*(?:months?|years?|mo\b))/g)].pop();
  const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  const from = pair ? Number(pair[1]) : undefined, to = pair ? Number(pair[2]) : nums[nums.length - 1];
  const others = nums.filter(n => n !== from && n !== to);
  let cands = numberSlots(m).filter(s => from === undefined || s.value === from);
  if (!cands.length) return { from: "agent", text: "I can't find " + (from ?? "that number") + " in the rules. The numbers in the rules are: " + [...new Set(numberSlots(m).map(s => s.value))].join(", ") + "." };
  const want = new Set(toks(t));
  const score = (s: (typeof cands)[number]) => toks(s.desc).filter(w => want.has(w)).length + others.filter(n => new RegExp("\\b" + n + "\\b").test(s.desc)).length * 2;
  const best = Math.max(...cands.map(score));
  cands = cands.filter(s => score(s) === best).slice(0, 4);
  const proposals: Proposal[] = cands.map(c => {
    const patch: Patch = { op: "set", path: c.path, value: to };
    const where = c.item.startsWith("rule:") ? "Rule " + c.item.slice(5) : c.item.replace(/^\w+:/, "").replace(/_/g, " ");
    const label = c.field === "due" ? where + ": follow-up due on day " + c.value + " → day " + to
      : where + ": " + condText(m, c.leaf) + " → " + to + (c.ctx ? "  (part of: " + c.ctx + ")" : "");
    return { label, item: c.item, field: c.field, patch, impact: impact(m, patch), state: "open" };
  });
  return { from: "agent", select: cands[0].item, proposals,
    text: proposals.length > 1 ? String(from ?? "That number") + " appears in " + proposals.length + " places. Pick the one you mean:" : "Here is the change and what it does. Nothing changes until you apply it." };
}
function whatIf(m: Spec, text: string): Msg | null {
  const p = patientFrom(m, text);
  if (!p) return null;
  const r = classify(m, p.a), o = r.out ? getO(m, r.out) : null, rule = r.rule ? getR(m, r.rule) : null;
  if (!o || !rule) return { from: "agent", text: "For " + describeP(m, p.a) + " no rule matches: the child gets no classification. That is a gap in the rules." };
  return {
    from: "agent", select: item.rule(rule.id),
    text: "A child with " + p.told.join(", ") + (p.assumed.length ? " (I assumed the child " + p.assumed.join(", ") + "; other signs no)" : " (other signs no)") + ": \""
      + o.title + "\". Rule " + rule.id + " decides it" + (rule.when === "otherwise" ? " (no earlier rule matched)" : ": " + condText(m, rule.when)) + "."
      + (o.actions.length ? " The health worker: " + o.actions.map(a => a.text).join(" ") : "")
      + (o.follow_up?.due_in_days ? " Follow-up on day " + o.follow_up.due_in_days + "." : ""),
  };
}

export function respond(w: Workflow, checks: Check[], text: string): Msg {
  const m = w.model, t = text.toLowerCase();
  const verb = /\b(change|set|make|raise|lower|increase|decrease|update|move|use|replace)\b/.test(t);
  const pair = /\d\s*(?:->|→|to)\s*\d/.test(t) && /\b(follow|day|threshold|breath|value|limit|cut-?off|rule)/.test(t) && !/\b(old|what happens|what if)\b/.test(t);
  if ((verb || pair) && /\d/.test(t)) {
    const r = proposeNumber(m, text);
    if (r) return r;
  }
  const ruleId = (t.match(/\br(\d+)\b/) || [])[1];
  if (ruleId && getR(m, "R" + ruleId) && !/\d+\s*(month|year|breath|day)/.test(t)) return explainRule(m, "R" + ruleId);
  if (/\b(what happens|what if|what would|patient|child|baby|infant|year|month|old|breath)/.test(t)) {
    const r = whatIf(m, text);
    if (r) return r;
  }
  const d = m.derived.find(x => t.includes(x.label.toLowerCase()) || t.includes(x.id.replace(/_/g, " ")));
  if (d) {
    const src = srcList(d.source)[0];
    return { from: "agent", select: item.d(d.id), text: "\"" + d.label + "\" is yes when " + condText(m, getD(m, d.id)!.definition) + "." + (src ? " Source, page " + src.page + ": \"" + src.quote + "\"" : "") };
  }
  if (/\b(golden|test (case|patient)s?)\b/.test(t)) {
    const g = golden(m), bad = g.filter(x => !x.ok);
    return { from: "agent", text: g.filter(x => x.ok).length + " of " + g.length + " test patients get the expected result." + (bad.length ? " Not matching: " + bad.map(x => x.id + " (" + describeP(m, x.a) + ") gets \"" + outName(m, x.got) + "\", expected \"" + outName(m, x.exp) + "\"").join("; ") + "." : ""), select: bad[0] && bad[0].rule ? item.rule(bad[0].rule) : undefined };
  }
  if (/\b(check|problem|error|issue|warning|fail)/.test(t)) {
    const st = checkStages(m, w.evidence);
    const bad = checks.slice(0, 3);
    return { from: "agent", select: bad[0]?.id, text: st.map(x => x.n + " " + x.name + ": " + x.summary).join(". ") + "." + (bad.length ? " First to look at: " + bad.map(c => c.text).join(" ") : "") };
  }
  if (/\b(question|open|left|todo|to do)\b/.test(t)) {
    const open = w.flags.filter(f => !f.res);
    return { from: "agent", text: open.length ? plural(open.length, "question") + " still open: " + open.map(f => f.id.slice(2) + " " + f.title).join(" | ") : "Every open question is answered.", select: open[0]?.about };
  }
  return { from: "agent", text: "I can: say what happens to a patient (\"8 month old, 52 breaths, no danger signs\"), explain a rule (\"explain R3\") or a value (\"what is fast breathing\"), propose a change (\"change 40 to 45\", \"follow-up day 3 to 2\"), list checks or test patients, or \"undo\" your last edit." };
}
