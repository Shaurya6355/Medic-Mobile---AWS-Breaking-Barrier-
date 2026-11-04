/* Workflow state machine: none -> po_draft -> clinician -> (po_revise -> clinician)* -> verify -> deploy -> done.
   Every transition is a pure function returning a new Workflow. The api layer persists the result. */
import { applyPatch, CondSyntaxError, itemOf, srcList, mutationScore, parse, print, splitItem, type Path, type Source } from "../../../shared/pathway/index.ts";
import { DRAFT, SAMPLE_EVIDENCE, V3, clone, fnv, hashOf } from "./data";
import { runChecks } from "./checks";
import { allItems, clean, changedVs, classify, getO, getQ, grid, nodeSig, qStatus, slots, srcOf, trayIds, usesOf, type Slot } from "./logic";
import type { Check, Decision, Evidence, FbType, Flag, ItemId, Model, Patch, Review, Suggestion, SuggestionOutcome, WfState, Workflow } from "./types";

export { applyPatch };

/** What the clinician can do with a flag the PO sent them. A change request needs a note; agreeing does not. */
const CLIN_OPTS = [{ label: "Agree, keep as drafted" }, { label: "Request a change", fb: {}, needsNote: true }];

/** Flags come from the logic model's open_questions. Every flag goes to the PO first; nothing reaches the clinician
    unless the PO sends it. route_to "clinician" only marks the flag as suggested for the clinician. */
export function flagsFrom(m: Model): Flag[] {
  return m.open_questions.filter(q => q.status === "open").map(q => {
    const src = srcList(q.source);
    return {
      id: "F-" + q.id, clinical: false, suggested: q.route_to === "clinician",
      kind: q.route_to === "clinician" ? "Clinical question" : "Open question",
      about: q.affects.map(a => itemOf(m, a)).find(Boolean) ?? "scope",
      title: clean(q.question),
      src: src.length ? src.map(s => "p. " + s.page + ": " + s.quote).join(" · ") : "No guideline passage",
      why: "Raised while drafting. Affects " + q.affects.join(", ") + ".",
      opts: [{ label: "Keep as drafted" }, { label: "Send to clinician", escalate: true, needsNote: true }],
    };
  });
}

/** All of this workflow's checks, against its own evidence (guideline text, draft B). */
export const checksOf = (w: Workflow): Check[] => runChecks(w.model, w.evidence);

export function initialWorkflow(id: string, m: Model = DRAFT, evidence: Evidence = SAMPLE_EVIDENCE): Workflow {
  return { id, guideline: null, state: "none", round: 0, rev: 0, model: clone(m), draft: clone(m), evidence, sent: null, required: [], reviews: {}, sug: {}, fixed: {},
    flags: flagsFrom(m), audit: [], versions: [], clock: 0, verify: null, approved: null, lastKey: null };
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
  const tray = new Set(trayIds(m));
  return allItems(m, V3).filter(id => {
    const [k, key] = splitItem(id);
    return k === "q" && tray.has(key) ? qStatus(m, key) !== "same" : changedVs(m, id);
  });
}
function expect(w: Workflow, ...states: WfState[]) {
  if (!states.includes(w.state)) throw new Error("Not allowed in state " + w.state);
}

/* ---------- AI revision from structured feedback (simulated Bedrock call). Output is a Patch, applied only if the PO accepts. ---------- */
const show = (v: unknown) => (v === undefined || v === null ? "(none)" : typeof v === "object" ? print(v as never) : String(v));
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
function bestSlot(cands: Slot[], text: string): Slot | undefined {
  const want = new Set(tokens(text));
  let best: Slot | undefined, score = -1;
  cands.forEach(s => { const n = tokens(s.label).filter(t => want.has(t)).length; if (n > score) { best = s; score = n; } });
  return best;
}
function sourcePath(m: Model, id: ItemId): Path | null {
  const [k, key] = splitItem(id);
  switch (k) {
    case "scope": return ["scope", "source"];
    case "q": return ["questions", key, "source"];
    case "d": return ["derived", key, "source"];
    case "rule": return ["rules", key, "source"];
    case "out": return ["outcomes", key, "source"];
    case "fu": return getO(m, key)?.follow_up ? ["outcomes", key, "follow_up", "source"] : null;
  }
  return null;
}

/** The field a change request is about, for the PO to type the change into when the AI could not. */
function targetFor(m: Model, id: ItemId, fb: Review): Extract<Suggestion, { kind: "clarify" }>["target"] {
  const [k, key] = splitItem(id);
  if (k === "q" && !getQ(m, key)) return undefined;
  const sl = slots(m, id), note = fb.note || "";
  const of = (s?: Slot) => (s ? { label: s.label, path: s.path, kind: s.kind, value: show(s.value) } : undefined);
  switch (fb.type) {
    case "wording": return of(bestSlot(sl.filter(s => s.kind === "text" || s.kind === "area"), note));
    case "value": return of(bestSlot(sl.filter(s => s.kind === "number" || s.kind === "numberOrNull"), note));
    case "logic": return of(sl.find(s => s.kind === "cond" && s.key !== "show"));
    case "show": {
      const q = k === "q" ? key : usesOf(m, id)[0];
      return q ? { label: "Shown when (" + q + ")", path: ["questions", q, "shown_when"], kind: "cond", value: show(getQ(m, q)?.shown_when) } : undefined;
    }
    case "source": {
      const p = sourcePath(m, id);
      if (!p) return undefined;
      const [quote, where] = srcOf(m, id);
      return { label: "Cited quote", path: p, kind: "source", value: quote, page: Number((where.match(/page (\d+)/) || [])[1]) || 1 };
    }
    default: return of(sl[0]);
  }
}
/** A value written into the note: quoted text, or what follows "to" / "should be" / "should read". */
function fromNote(note: string): string {
  const q = note.match(/[“"‘']([^”"’']{2,})[”"’']/);
  if (q) return q[1].trim();
  const t = note.match(/\b(?:to|should be|should read|instead)\s*:?\s*(.+)$/i);
  return t ? t[1].trim().replace(/[.]$/, "") : "";
}

export function suggest(m: Model, id: ItemId, fb: Review): Suggestion {
  const s = draftSuggestion(m, id, fb);
  return s.kind === "clarify" ? { ...s, target: targetFor(m, id, fb) } : s;
}
function draftSuggestion(m: Model, id: ItemId, fb: Review): Suggestion {
  const note = (fb.note || "").replace(/\s*\(flag [^)]*\)\s*$/, "").trim();
  const typed = (fb.value || "").trim();
  const guess = fromNote(note);
  // Wording and citations only take a quoted value from the note; conditions take whatever parses.
  const val = typed || (fb.type === "wording" || fb.type === "source" ? (/[“"‘']/.test(note) ? guess : "") : fb.type === "logic" || fb.type === "show" ? [guess, note].find(c => { try { parse(c); return true; } catch { return false; } }) ?? "" : "");
  const lower = (note + " " + val).toLowerCase();
  const clar = (text: string): Suggestion => ({ kind: "clarify", text });
  const mk = (field: string, from: unknown, to: unknown, patch: Patch): Suggestion => ({ kind: "change", field, from: show(from), to: show(to), patch });
  if (!val && note.length < 25 && !/\d/.test(note)) return clar("The note does not say exactly what to change. Type the change below and accept it, or edit the step yourself.");
  const [k, key] = splitItem(id);
  if (k === "q" && !getQ(m, key)) return clar("This question is not in v4. Restore it first, then apply the change.");
  const sl = slots(m, id);
  const condFrom = (text: string): Suggestion | ReturnType<typeof parse> => {
    try { return parse(text); } catch (e) { return clar("Couldn't read the condition: " + (e instanceof CondSyntaxError ? e.message : String(e)) + ". Write it like: danger_sign is yes and fast_breathing is yes"); }
  };
  const isSug = (x: unknown): x is Suggestion => !!x && typeof x === "object" && "kind" in x;
  switch (fb.type) {
    case "wording": {
      if (!val) return clar("No exact value in the feedback: no new wording was given.");
      const texts = sl.filter(s => s.kind === "text" || s.kind === "area");
      const s = k === "out" ? (/name|title|classif/.test(note.toLowerCase()) ? texts[0] : texts.find(t => t.kind === "area") ?? texts[0]) : bestSlot(texts, note);
      if (!s) return clar("Wording does not apply to this box. Say what should change.");
      return mk(s.label, s.value, val, { op: "set", path: s.path, value: val });
    }
    case "value": {
      const nums = (val || note).match(/-?\d+(?:\.\d+)?/g);
      const num = nums ? Number(nums[nums.length - 1]) : NaN;
      const cands = sl.filter(s => s.kind === "number" || s.kind === "numberOrNull");
      if (!cands.length) return clar("This box has no numeric value. Say which value should change, or request a wording or rule logic change.");
      if (isNaN(num)) return clar("No exact value in the feedback: no number was given.");
      const s = bestSlot(cands, note)!;
      return mk(s.label, s.value, num, { op: "set", path: s.path, value: num });
    }
    case "logic": {
      const s = sl.find(x => x.kind === "cond" && x.key !== "show");
      if (!s) return clar("This box has no rule logic. Pick the rule or derived value to change.");
      if (!val) return clar("No exact value in the feedback: give the new condition, for example: danger_sign is yes and fast_breathing is yes");
      const c = condFrom(val);
      if (isSug(c)) return c;
      return mk(s.label, s.value, c, { op: "set", path: s.path, value: c });
    }
    case "show": {
      if (!val) return clar("No exact value in the feedback: give the new show condition, for example: cough is yes");
      const qs = usesOf(m, id);
      const target = k === "q" ? key : qs.find(q => lower.includes(q.replace(/_/g, " ")) || lower.includes(q)) || qs[0];
      if (!target) return clar("Show conditions belong to questions. Pick the question.");
      const c = condFrom(val);
      if (isSug(c)) return c;
      return mk("Shown when (" + target + ")", getQ(m, target)?.shown_when, c, { op: "set", path: ["questions", target, "shown_when"], value: c });
    }
    case "source": {
      if (!val) return clar("No exact value in the feedback: say which passage to cite instead.");
      const p = sourcePath(m, id);
      if (!p) return clar("This box has no citation.");
      const [old, where] = srcOf(m, id);
      const page = Number((where.match(/page (\d+)/) || [])[1]) || Number((note.match(/page (\d+)/i) || [])[1]) || 1;
      const src: Source = { page, quote: val };
      return mk("Cited quote", old, val, { op: "set", path: p, value: src });
    }
    case "remove":
      if (k === "q") return mk("Question " + key, getQ(m, key)!.label, "(removed)", { op: "removeQ", q: key });
      return clar("Removing a whole step changes the decision table. Ask what should replace it.");
    default: {
      const label = val || note;
      const qid = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/^(\d)/, "q_$1").slice(0, 24) || "new_question";
      const order = Math.max(0, ...m.questions.map(q => q.order)) + 1;
      return mk("New question " + qid, "(none)", label, { op: "addQ", question: { id: qid, order, label, answer_type: "yes_no", required: true, origin: "team" } });
    }
  }
}
export function suggestionCheckText(w: Workflow, s: Suggestion): string | null {
  if (s.kind !== "change") return null;
  const m = w.model, x = applyPatch(m, s.patch);
  const c = runChecks(x, w.evidence), b = c.filter(r => r.sev === "blocking").length;
  const wn = c.filter(r => r.sev === "warning").length - runChecks(m, w.evidence).filter(r => r.sev === "warning").length;
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
export function createDraft(w: Workflow, g: { id: string; name: string; pathway: string; pages: number[] }, from?: { model: Model; event: string; note: string; evidence: Evidence }): Workflow {
  expect(w, "none");
  let x: Workflow = { ...initialWorkflow(w.id), state: "po_draft", guideline: g };
  if (from) x = { ...x, model: clone(from.model), draft: clone(from.model), flags: flagsFrom(from.model), evidence: from.evidence };
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
  const g = gate(w, checksOf(w));
  if (g.blockIds.length) throw new Error("Blocking checks are open");
  let y: Workflow;
  if (w.state === "po_draft") {
    if (g.poFlags.length) throw new Error("Program officer flags are open");
    y = { ...w, state: "clinician", round: 1, rev: 0, required: requiredFor(w.model), reviews: {} };
  } else {
    if (g.unresolved.length) throw new Error("Clinician feedback is not resolved");
    const sent = w.sent || V3;
    const ids = allItems(w.model, sent);
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
  // Approving a step agrees with its open flags too: one click, no note.
  const flags = d?.status === "approved"
    ? w.flags.map(f => f.clinical && !f.res && f.about === item ? { ...f, res: { choice: CLIN_OPTS[0].label, note: "", by: "Clinician", round: w.round } } : f)
    : w.flags;
  return logged({ ...w, reviews, flags }, "Clinician", event, d?.note || "");
}

export function decideFlag(w: Workflow, flagId: string, choice: number, note: string): Workflow {
  const f = w.flags.find(z => z.id === flagId);
  if (!f || f.res) throw new Error("Flag not open");
  expect(w, ...(f.clinical ? ["clinician"] as WfState[] : ["po_draft", "po_revise"] as WfState[]));
  const o = f.opts[choice];
  if (o.needsNote && !note.trim()) throw new Error("A note is required to send this on or to request a change");
  const by = f.clinical ? "Clinician" : "Program officer";
  if (o.escalate) {
    const flags = w.flags.map(z => z.id === flagId ? { ...z, clinical: true, escalated: true, poNote: note, opts: CLIN_OPTS } : z);
    return logged({ ...w, flags }, by, "Sent flag " + flagId + " to the clinician", note);
  }
  let y: Workflow = { ...w, flags: w.flags.map(z => z.id === flagId ? { ...z, res: { choice: o.label, note, by, round: w.round } } : z) };
  if (o.fb && f.clinical) {
    const [k] = splitItem(f.about);
    const type: FbType = o.fb.type ?? (/\d/.test(note) ? "value" : k === "out" ? "wording" : "logic");
    y = { ...y, reviews: { ...w.reviews, [f.about]: { status: "changes", type, note: note + " (flag " + flagId + ")", value: "", round: w.round } } };
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

/** `patch` overrides the suggested change: the PO typed the value themselves (always possible, even when the AI asked for clarification). */
export function decideSuggestion(w: Workflow, item: ItemId, outcome: SuggestionOutcome, patch?: Patch): Workflow {
  expect(w, "po_revise");
  const s = w.sug[item];
  if (!s) throw new Error("No suggestion for " + item);
  const p = patch ?? (s.kind === "change" ? s.patch : null);
  if (outcome !== "discarded" && !p) throw new Error("Nothing to apply: type the change first");
  let y: Workflow = { ...w, sug: { ...w.sug, [item]: { ...s, outcome } } };
  if (outcome !== "discarded" && p) {
    y = { ...y, model: applyPatch(w.model, p), rev: w.rev + 1, lastKey: null };
    y = addVersion(y, outcome === "accepted" ? "AI revision accepted (" + item + ")" : "AI revision applied, then edited (" + item + ")", "Program officer");
  }
  const verb = outcome === "accepted" ? "Accepted" : outcome === "edited" ? "Applied and editing" : "Discarded";
  return logged(y, "Program officer", verb + (patch ? " own revision on " : " AI revision on ") + item, patch ? "typed by the program officer" : s.kind === "change" ? s.field + ": " + s.to : s.text);
}

export function approveAll(w: Workflow): Workflow {
  expect(w, "clinician");
  const g = gate(w, checksOf(w));
  if (g.reqLeft.length || g.clinFlags.length || g.changesNow.length) throw new Error("Round is not fully approved");
  let y: Workflow = { ...w, state: "verify", approved: { ver: "v4." + w.round, hash: hashOf(w.model), round: w.round } };
  y = addVersion(y, "Approved by clinician", "Clinician");
  return logged(y, "Clinician", "Approved all (round " + w.round + ")", "Approval bound to " + y.approved!.hash);
}

/** Simulated: the real step builds with cht-conf and runs cht-conf-test-harness. Expected outcomes always come from classify(). */
export function runVerify(w: Workflow): Workflow {
  expect(w, "verify");
  const m = w.model, ps = grid(m), res = ps.map(p => classify(m, p));
  const mu = mutationScore(m, ps);
  const v = {
    match: ps.length, total: ps.length,
    cov: new Set(res.map(r => r.rule)).size, covTotal: m.rules.length,
    tasks: res.filter(r => r.out && getO(m, r.out)?.follow_up).length,
    mut: mu.killed, mutTotal: mu.total,
  };
  let y: Workflow = { ...w, verify: v, state: "deploy" };
  y = logged(y, "System", "cht-conf build passed; synthetic check passed", v.match + "/" + v.total + " match · " + v.mut + " of " + v.mutTotal + " threshold mutants caught");
  return logged(y, "System", "Sent to IT approver");
}

export function approveDeploy(w: Workflow): Workflow {
  expect(w, "deploy");
  return logged({ ...w, state: "done" }, "IT approver", "Approved deploy", "Upload to CHT test instance; rollback target v3 " + fnv(JSON.stringify(V3)));
}

/** The current role's open items as step ids, in order (a flag counts as the step it is about). Drives Next buttons. */
export function todoItems(w: Workflow, role: string, checks: Check[]): ItemId[] {
  const g = gate(w, checks);
  const about = (fs: Flag[]) => fs.map(f => f.about);
  let ids: ItemId[] = [];
  if (w.state === "po_draft" && role === "po") ids = [...g.blockIds, ...about(g.poFlags)];
  else if (w.state === "po_revise" && role === "po") ids = [...g.unresolved, ...g.blockIds, ...about(g.poFlags)];
  else if (w.state === "clinician" && role === "clinician") ids = [...g.reqLeft, ...about(g.clinFlags)];
  const order = allItems(w.model, V3);
  return [...new Set(ids)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
/** The clinician's steps for this round: everything sent to them, in order, done or not. */
export function clinicianSteps(w: Workflow): ItemId[] {
  const order = allItems(w.model, V3);
  return [...new Set([...w.required, ...w.flags.filter(f => f.clinical).map(f => f.about)])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Flags this role sees: the PO sees every flag; the clinician only those the PO sent them. */
export const flagsFor = (w: Workflow, role: string) => w.flags.filter(f => role !== "clinician" || f.clinical || f.res?.by === "Clinician");
