/* Workflow state machine: none -> po_draft -> clinician -> (po_revise -> clinician)* -> verify -> deploy -> done.
   Every transition is a pure function returning a new Workflow. The api layer persists the result. */
import { AI_DRAFT, COND, GRID, NODE_IDS, V3, clone, fnv, hashOf } from "./data";
import { changedVs, classify, nodeSig, qStatus, runChecks, trayIds, usesOf, isNode } from "./logic";
import type { Check, CondKey, Decision, Flag, ItemId, Model, Patch, Review, Suggestion, SuggestionOutcome, WfState, Workflow } from "./types";

const PASS_B: Model = (() => { const x = clone(AI_DRAFT); x.d2.conds = ["ci", "stridor"]; return x; })();
const PASS_DISAGREE = GRID.filter(p => classify(AI_DRAFT, p).out !== classify(PASS_B, p).out).length;

export const FLAGS0: Flag[] = [
  { id: "F-1", clinical: true, kind: "Ambiguity", about: "d3", title: "Does exactly 12 months use 50/min or 40/min?",
    src: "2 months up to 12 months · 12 months up to 5 years", why: "A child of exactly 12 months fits both bands as written. The draft uses 40/min at 12 months.",
    opts: [{ label: "40/min at 12 months (as drafted)" }, { label: "50/min at 12 months", fb: { type: "value", note: "Age cut-off: exactly 12 months should use the younger threshold, so the cut-off moves to 13 months", value: "13" } }] },
  { id: "F-2", clinical: true, kind: "Cross-check", about: "d3", title: "Chest indrawing: pneumonia or severe?",
    src: "Chest indrawing or fast breathing", why: "Pass B kept chest indrawing under severe, as in the 2008 edition. The two passes give different outcomes for " + PASS_DISAGREE + " of " + GRID.length + " synthetic patients.",
    opts: [{ label: "Pneumonia (pass A, 2014 text)" }, { label: "Severe (pass B)", fb: { type: "value", about: "d2", note: "Add chest indrawing back to the severe signs", value: "chest indrawing" } }] },
  { id: "F-3", clinical: false, kind: "Uncited passage", about: "q:wheeze", title: "Wheeze passage not used by any rule",
    src: "If wheezing with either fast breathing or chest indrawing: give a trial of rapid acting inhaled bronchodilator...", why: "It has decision words, but no rule cites it. The wheeze question is asked but unused.",
    opts: [{ label: "Out of scope for CHWs (keep the question, note why)" }, { label: "Escalate to clinician", escalate: true }] },
];

export function initialWorkflow(id: string): Workflow {
  return { id, guideline: null, state: "none", round: 0, rev: 0, model: clone(AI_DRAFT), draft: clone(AI_DRAFT), sent: null, required: [], reviews: {}, sug: {}, fixed: {},
    flags: clone(FLAGS0), audit: [], versions: [], clock: 0, verify: null, approved: null, lastKey: null };
}

/* ---------- Patches: the only way the model changes ---------- */
export function applyPatch(m: Model, p: Patch): Model {
  const x = clone(m);
  switch (p.op) {
    case "set": (x[p.node] as unknown as Record<string, unknown>)[p.key] = p.value; break;
    case "setQ": if (x.questions[p.q]) x.questions[p.q][p.key] = p.value; break;
    case "removeQ": delete x.questions[p.q]; break;
    case "addQ": x.questions[p.q] = clone(p.question); break;
    case "setSrc": x.src[p.node] = p.value; break;
  }
  return x;
}

/* ---------- Versions and audit ---------- */
const fmtTime = (t: number) => { const mm = 9 * 60 + t; return "Nov 3, " + String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0"); };
export function verLabel(w: Workflow): string {
  if (w.state === "none") return "-";
  if (w.state === "po_draft") return "v4.0" + (w.rev ? "." + w.rev : "");
  if (w.state === "po_revise") return "v4." + w.round + (w.rev ? "." + w.rev : "");
  return "v4." + w.round;
}
function logged(w: Workflow, actor: string, event: string, note = ""): Workflow {
  const clock = w.clock + 2;
  return { ...w, clock, audit: w.audit.concat({ t: fmtTime(clock), actor, event, ver: verLabel(w), hash: hashOf(w.model), note }) };
}
function addVersion(w: Workflow, event: string, by: string): Workflow {
  return { ...w, versions: w.versions.concat({ ver: verLabel(w), event, meta: hashOf(w.model) + " · " + by + " · " + fmtTime(w.clock) }) };
}
function requiredFor(m: Model): ItemId[] {
  const ids: ItemId[] = NODE_IDS.filter(id => changedVs(m, id));
  trayIds(m).forEach(q => { if (qStatus(m, q) !== "same") ids.push("q:" + q); });
  return ids;
}
function expect(w: Workflow, ...states: WfState[]) {
  if (!states.includes(w.state)) throw new Error("Not allowed in state " + w.state);
}

/* ---------- AI revision from structured feedback (simulated Bedrock call). Output is a Patch, applied only if the PO accepts. ---------- */
export function suggest(m: Model, id: ItemId, fb: Review): Suggestion {
  const note = (fb.note || "").trim(), val = (fb.value || "").trim(), lower = (note + " " + val).toLowerCase();
  const clar = (text: string): Suggestion => ({ kind: "clarify", text });
  const mk = (field: string, from: unknown, to: unknown, patch: Patch): Suggestion => ({ kind: "change", field, from: String(from), to: String(to), patch });
  if (!val && note.length < 25) return clar("Needs clarification: the note does not say what to change. Ask the clinician for the exact wording or value, or edit it yourself.");
  const isQ = id.startsWith("q:"), q = isQ ? id.slice(2) : "";
  if (isQ && !m.questions[q]) return clar("This question is not in v4. Restore it first, then apply the change.");
  const node = isNode(id) ? id : null;
  switch (fb.type) {
    case "wording":
      if (!val) return clar("Needs clarification: no new wording was given.");
      if (isQ) return mk("Question label", m.questions[q].label, val, { op: "setQ", q, key: "label", value: val });
      if (node === "d1" || node === "d2" || node === "d3") return mk("Question", m[node].q, val, { op: "set", node, key: "q", value: val });
      if (node === "o1" || node === "o2" || node === "o3")
        return /name|title|classif/.test(note.toLowerCase())
          ? mk("Classification name", m[node].title, val, { op: "set", node, key: "title", value: val })
          : mk("Note shown to the CHW", m[node].note, val, { op: "set", node, key: "note", value: val });
      if (node === "f1") return mk("Task title", m.f1.title, val, { op: "set", node, key: "title", value: val });
      return clar("Wording does not apply to this box. Say what should change.");
    case "value": {
      const num = parseFloat(val.replace(/[^\d.]/g, ""));
      if ((node === "d2" || node === "d3") && isNaN(num) && /indrawing|stridor|fast/.test(lower)) {
        const key: CondKey = /indrawing/.test(lower) ? "ci" : /stridor/.test(lower) ? "stridor" : "fast";
        const rem = /remove|drop|\bnot\b|without|shouldn/.test(lower);
        const next = rem ? m[node].conds.filter(c => c !== key) : [...new Set([...m[node].conds, key])];
        return mk("Yes if any of", m[node].conds.map(c => COND[c]).join(", "), next.map(c => COND[c]).join(", "), { op: "set", node, key: "conds", value: next });
      }
      if (isNaN(num)) return clar("Needs clarification: no number was given.");
      if (node === "d3") {
        const f = /cut-?off|age/.test(note.toLowerCase()) ? "cut" : /older|over|after/.test(lower) ? "old" : "young";
        const label = { cut: "Age cut-off (months)", young: "Threshold under the cut-off (/min)", old: "Threshold at or over the cut-off (/min)" }[f];
        return mk(label, m.d3[f], num, { op: "set", node, key: f, value: num });
      }
      if (node === "f1") { const f = /open|until|end|close/.test(lower) ? "end" : "due"; return mk(f === "due" ? "Due on day" : "Open until day", m.f1[f], num, { op: "set", node, key: f, value: num }); }
      if (node === "start") { const f = /youngest|from|min/.test(lower) ? "ageMin" : "ageMax"; return mk(f === "ageMin" ? "Youngest age (months)" : "Up to age (months)", m.start[f], num, { op: "set", node, key: f, value: num }); }
      return clar("This box has no numeric value. Say which value should change.");
    }
    case "show": {
      if (!val) return clar("Needs clarification: give the new show condition, for example cough = yes.");
      const target = isQ ? q : (usesOf(m, id).find(k => lower.includes(k.replace("_", " "))) || usesOf(m, id)[0]);
      if (!target) return clar("Show conditions belong to questions. Pick the question.");
      return mk("Shown when (" + target + ")", m.questions[target].showIf || "always", val, { op: "setQ", q: target, key: "showIf", value: val });
    }
    case "source":
      if (!val) return clar("Needs clarification: say which passage to cite instead.");
      if (isQ) return mk("Cited quote", m.questions[q].quote, val, { op: "setQ", q, key: "quote", value: val });
      if (!node) return clar("This box has no citation.");
      return mk("Cited quote", m.src[node][0], val, { op: "setSrc", node, value: [val, m.src[node][1]] });
    case "remove":
      if (isQ) return mk("Question " + q, m.questions[q].label, "(removed)", { op: "removeQ", q });
      return clar("Removing a whole step changes the decision table. Ask what should replace it.");
    default: {
      const label = val || note;
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "new_question";
      return mk("New question " + key, "(none)", label, { op: "addQ", q: key, question: { type: "yesno", label, showIf: "cough = yes", quote: "From clinician feedback; no guideline quote yet" } });
    }
  }
}
export function suggestionCheckText(m: Model, s: Suggestion): string | null {
  if (s.kind !== "change") return null;
  const x = applyPatch(m, s.patch);
  const c = runChecks(x), b = c.filter(r => r.sev === "blocking").length;
  const wn = c.filter(r => r.sev === "warning").length - runChecks(m).filter(r => r.sev === "warning").length;
  return b ? b + " blocking check" + (b > 1 ? "s" : "") + " after this change"
    : "Checks re-run on the proposed change: no blocking problems" + (wn > 0 ? ", " + wn + " new warning" + (wn > 1 ? "s" : "") : "");
}

/* ---------- Gate: what is still open in the current state ---------- */
export function gate(w: Workflow, checks: Check[]) {
  const blockIds = [...new Set(checks.filter(c => c.sev === "blocking").map(c => c.id))];
  const poFlags = w.flags.filter(f => !f.clinical && !f.res);
  const clinFlags = w.flags.filter(f => f.clinical && !f.res);
  const changesNow = Object.keys(w.reviews).filter(k => w.reviews[k].status === "changes" && w.reviews[k].round === w.round);
  const isResolved = (id: ItemId) => { const s = w.sug[id]; return (s && (s.outcome === "accepted" || s.outcome === "edited")) || !!w.fixed[id]; };
  const unresolved = changesNow.filter(id => !isResolved(id));
  const reqLeft = w.required.filter(id => !(w.reviews[id] && w.reviews[id].round === w.round));
  return { blockIds, poFlags, clinFlags, changesNow, unresolved, reqLeft, isResolved };
}

/* ---------- Transitions ---------- */
/** `from` is a logic model loaded from the pipeline; without it the built-in sample draft is used. */
export function createDraft(w: Workflow, g: { id: string; name: string; pathway: string; pages: number[] }, from?: { model: Model; event: string; note: string }): Workflow {
  expect(w, "none");
  let x: Workflow = { ...initialWorkflow(w.id), state: "po_draft", guideline: g };
  if (from) x = { ...x, model: clone(from.model), draft: clone(from.model) };
  x = logged(x, "Program officer", "Created workflow draft", "Pages " + g.pages.join(", ") + " of " + g.name);
  x = from ? logged(x, "System", from.event, from.note)
    : logged(x, "System", "Drafted by Bedrock (inputs pass, rules pass, cross-check pass)", "Every quote and number checked against the source in code");
  return addVersion(x, "AI draft", "System");
}

export function applyEdit(w: Workflow, item: ItemId, field: string, patch: Patch): Workflow {
  expect(w, "po_draft", "po_revise");
  const m = applyPatch(w.model, patch);
  const key = item + ":" + field;
  let y: Workflow = { ...w, model: m };
  if (w.lastKey !== key || ["remove", "restore"].includes(field)) {
    y = { ...y, rev: w.rev + 1 };
    y = addVersion(y, "PO edited " + item, "Program officer");
    y = logged(y, "Program officer", "Edited " + item, field);
  } else {
    const v = y.versions.slice();
    v[v.length - 1] = { ...v[v.length - 1], meta: hashOf(m) + " · Program officer · " + fmtTime(y.clock) };
    y.versions = v;
  }
  y.lastKey = key;
  if (w.state === "po_revise" && w.reviews[item]?.status === "changes") y.fixed = { ...w.fixed, [item]: true };
  return y;
}

export function sendToClinician(w: Workflow): Workflow {
  expect(w, "po_draft", "po_revise");
  const g = gate(w, runChecks(w.model));
  if (g.blockIds.length) throw new Error("Blocking checks are open");
  let y: Workflow;
  if (w.state === "po_draft") {
    if (g.poFlags.length) throw new Error("Program officer flags are open");
    y = { ...w, state: "clinician", round: 1, rev: 0, required: requiredFor(w.model), reviews: {} };
  } else {
    if (g.unresolved.length) throw new Error("Clinician feedback is not resolved");
    const sent = w.sent || V3;
    const ids: ItemId[] = [...NODE_IDS, ...Object.keys({ ...w.model.questions, ...V3.questions }).map(q => "q:" + q)];
    const changed = ids.filter(id => nodeSig(w.model, id) !== nodeSig(sent, id));
    const prevReq = Object.keys(w.reviews).filter(k => w.reviews[k].status === "changes");
    const required = [...new Set(changed.concat(prevReq))];
    const keep: Record<ItemId, Review> = {};
    Object.keys(w.reviews).forEach(k => { if (w.reviews[k].status === "approved" && !required.includes(k)) keep[k] = w.reviews[k]; });
    y = { ...w, state: "clinician", round: w.round + 1, rev: 0, required, reviews: keep };
  }
  y = { ...y, sent: clone(w.model), sug: {}, fixed: {}, lastKey: null };
  y = addVersion(y, "Sent to clinician, round " + y.round, "Program officer");
  return logged(y, "Program officer", "Sent to clinician (round " + y.round + ")", y.required.length + " boxes to review");
}

export function submitReview(w: Workflow, item: ItemId, d: Decision | null): Workflow {
  expect(w, "clinician");
  if (d?.status === "changes" && (!d.type || !d.note?.trim())) throw new Error("A change request needs a type and a note");
  const reviews = { ...w.reviews };
  if (d) reviews[item] = { ...d, round: w.round }; else delete reviews[item];
  const event = d ? (d.status === "approved" ? "Approved " + item : "Requested change on " + item) : "Cleared decision on " + item;
  return logged({ ...w, reviews }, "Clinician", event, d?.note || "");
}

export function decideFlag(w: Workflow, flagId: string, choice: number, note: string): Workflow {
  const f = w.flags.find(z => z.id === flagId);
  if (!f || f.res) throw new Error("Flag not open");
  expect(w, ...(f.clinical ? ["clinician"] as WfState[] : ["po_draft", "po_revise"] as WfState[]));
  if (!note.trim()) throw new Error("A note is required");
  const o = f.opts[choice];
  const by = f.clinical ? "Clinician" : "Program officer";
  if (o.escalate) {
    const flags = w.flags.map(z => z.id === flagId ? { ...z, clinical: true, escalated: true } : z);
    return logged({ ...w, flags }, by, "Escalated flag " + flagId + " to clinician", note);
  }
  let y: Workflow = { ...w, flags: w.flags.map(z => z.id === flagId ? { ...z, res: { choice: o.label, note, by, round: w.round } } : z) };
  if (o.fb && f.clinical) {
    const about = o.fb.about || f.about;
    y = { ...y, reviews: { ...w.reviews, [about]: { status: "changes", type: o.fb.type, note: o.fb.note + " (flag " + flagId + ")", value: o.fb.value, round: w.round } } };
  }
  return logged(y, by, "Decided flag " + flagId + ": " + o.label, note);
}

export function returnToPO(w: Workflow): Workflow {
  expect(w, "clinician");
  const sug: Record<ItemId, Suggestion> = {}; let k = 0, c = 0;
  Object.keys(w.reviews).forEach(id => {
    const r = w.reviews[id];
    if (r.status === "changes" && r.round === w.round) { sug[id] = suggest(w.model, id, r); if (sug[id].kind === "change") k++; else c++; }
  });
  if (!Object.keys(sug).length) throw new Error("No change requests to return");
  let y: Workflow = { ...w, state: "po_revise", sug, fixed: {}, rev: 0, lastKey: null };
  y = logged(y, "Clinician", "Returned to PO with feedback (round " + w.round + ")", Object.keys(sug).length + " change requests");
  return logged(y, "System", "AI revisions drafted from feedback", k + " proposed, " + c + " need clarification");
}

export function decideSuggestion(w: Workflow, item: ItemId, outcome: SuggestionOutcome): Workflow {
  expect(w, "po_revise");
  const s = w.sug[item];
  if (!s) throw new Error("No suggestion for " + item);
  let y: Workflow = { ...w, sug: { ...w.sug, [item]: { ...s, outcome } } };
  if ((outcome === "accepted" || outcome === "edited") && s.kind === "change") {
    y = { ...y, model: applyPatch(w.model, s.patch), rev: w.rev + 1, lastKey: null };
    y = addVersion(y, outcome === "accepted" ? "AI revision accepted (" + item + ")" : "AI revision applied, then edited (" + item + ")", "Program officer");
  }
  const verb = outcome === "accepted" ? "Accepted" : outcome === "edited" ? "Applied and editing" : "Discarded";
  return logged(y, "Program officer", verb + " AI revision on " + item, s.kind === "change" ? s.field + ": " + s.to : s.text);
}

export function approveAll(w: Workflow): Workflow {
  expect(w, "clinician");
  const g = gate(w, runChecks(w.model));
  if (g.reqLeft.length || g.clinFlags.length || g.changesNow.length) throw new Error("Round is not fully approved");
  let y: Workflow = { ...w, state: "verify", approved: { ver: "v4." + w.round, hash: hashOf(w.model), round: w.round } };
  y = addVersion(y, "Approved by clinician", "Clinician");
  return logged(y, "Clinician", "Approved all (round " + w.round + ")", "Approval bound to " + y.approved!.hash);
}

/** Simulated: the real step builds with cht-conf and runs cht-conf-test-harness. Expected outcomes always come from classify(). */
export function runVerify(w: Workflow): Workflow {
  expect(w, "verify");
  const m = w.model, mut = clone(m); mut.d3.young += 1;
  const v = {
    match: GRID.length, total: GRID.length,
    cov: new Set(GRID.map(p => classify(m, p).rule).filter(r => r !== "start")).size,
    tasks: GRID.filter(p => classify(m, p).out === "o2").length,
    mut: GRID.filter(p => classify(mut, p).out !== classify(m, p).out).length,
  };
  let y: Workflow = { ...w, verify: v, state: "deploy" };
  y = logged(y, "System", "cht-conf build passed; synthetic check passed", v.match + "/" + v.total + " match · mutation caught " + v.mut);
  return logged(y, "System", "Sent to IT approver");
}

export function approveDeploy(w: Workflow): Workflow {
  expect(w, "deploy");
  return logged({ ...w, state: "done" }, "IT approver", "Approved deploy", "Upload to CHT test instance; rollback target v3 " + fnv(JSON.stringify(V3)));
}
