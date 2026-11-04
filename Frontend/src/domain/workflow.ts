/* Workflow state machine: none -> clinician -> verify -> deploy -> done.
   The AI agent takes the draft first: it runs checks 1 to 3, fixes what it safely can, and puts the open
   questions to the clinician. The clinician reviews (view), edits (table) and talks to the assistant, then
   approves. The IT approver deploys. Every transition is a pure function returning a new Workflow. */
import { applyPatch, itemOf, srcList, mutationScore } from "../../../shared/pathway/index.ts";
import { DRAFT, SAMPLE_EVIDENCE, V3, clone, fnv, hashOf } from "./data";
import { runChecks } from "./checks";
import { agentPass, intro, respond } from "./agent";
import { clean, classify, getO, grid } from "./logic";
import type { ChatMsg, Check, Evidence, Flag, ItemId, Model, Patch, Remote, WfState, Workflow } from "./types";

export { applyPatch };

/** Open questions from the logic model. With no program officer, every one goes to the clinician. */
export function flagsFrom(m: Model): Flag[] {
  return m.open_questions.filter(q => q.status === "open").map(q => {
    const src = srcList(q.source);
    return {
      id: "F-" + q.id,
      about: q.affects.map(a => itemOf(m, a)).find(Boolean) ?? "scope",
      title: clean(q.question),
      src: src.length ? src.map(s => "p. " + s.page + ": " + s.quote).join(" · ") : "No guideline passage",
      why: "Affects " + q.affects.join(", ") + ".",
    };
  });
}

/** All of this workflow's checks, against its own evidence (guideline text, draft B). */
export const checksOf = (w: Workflow): Check[] => runChecks(w.model, w.evidence);

export function initialWorkflow(id: string, m: Model = DRAFT, evidence: Evidence = SAMPLE_EVIDENCE): Workflow {
  return { id, guideline: null, state: "none", rev: 0, model: clone(m), draft: clone(m), evidence, flags: flagsFrom(m), chat: [], agent: [], undo: [],
    audit: [], versions: [], clock: 0, verify: null, approved: null, lastKey: null, remote: null };
}

/* ---------- Versions and audit ---------- */
const fmtTime = (t: number) => { const mm = 9 * 60 + t; return "Nov 3, " + String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0"); };
export function verLabel(w: Workflow): string {
  if (w.state === "none") return "-";
  if (w.state === "clinician") return "v4.0" + (w.rev ? "." + w.rev : "");
  return w.approved?.ver ?? "v4.0";
}
function logged(w: Workflow, actor: string, event: string, note = ""): Workflow {
  const clock = w.clock + 2;
  return { ...w, clock, audit: w.audit.concat({ t: fmtTime(clock), actor, event, ver: verLabel(w), hash: hashOf(w.model), note }) };
}
function addVersion(w: Workflow, event: string, by: string): Workflow {
  return { ...w, versions: w.versions.concat({ ver: verLabel(w), event, meta: hashOf(w.model) + " · " + by + " · " + fmtTime(w.clock) }) };
}
function expect(w: Workflow, ...states: WfState[]) {
  if (!states.includes(w.state)) throw new Error("Not allowed in state " + w.state);
}
const say = (w: Workflow, ...msgs: Omit<ChatMsg, "id">[]): Workflow => {
  let n = w.chat.length ? w.chat[w.chat.length - 1].id : 0;
  return { ...w, chat: w.chat.concat(msgs.map(m => ({ ...m, id: ++n }))) };
};

/* ---------- Gate: what still stops approval ---------- */
export function gate(w: Workflow, checks: Check[]) {
  const blockIds = [...new Set(checks.filter(c => c.sev === "blocking").map(c => c.id))];
  const asks = w.flags.filter(f => !f.res);
  return { blockIds, asks, ready: !blockIds.length && !asks.length };
}

/* ---------- Transitions ---------- */
/** `from` is a logic model loaded from the pipeline; without it the built-in sample draft is used. */
export function createDraft(w: Workflow, g: { id: string; name: string; pathway: string; pages: number[] }, from?: { model: Model; event: string; note: string; evidence: Evidence; remote?: Remote }): Workflow {
  expect(w, "none");
  let x: Workflow = { ...initialWorkflow(w.id), guideline: g };
  if (from) x = { ...x, model: clone(from.model), flags: flagsFrom(from.model), evidence: from.evidence, remote: from.remote ?? null };
  x = logged(x, "Clinician", "Started a workflow", "Pages " + g.pages.join(", ") + " of " + g.name);
  x = from ? logged(x, "System", from.event, from.note) : logged(x, "System", "Drafted by Bedrock (draft A and draft B)", "Every quote and number checked against the source in code");
  // The AI agent's pass: checks 1 to 3, safe fixes, then hand over.
  const a = agentPass(x.model, x.evidence);
  x = { ...x, model: a.model, draft: clone(a.model), agent: a.fixes, state: "clinician" };
  x = logged(x, "AI agent", "Checked the draft (schema, quotes, numbers, logic)", a.fixes.length ? a.fixes.length + " fixed" : "nothing to fix");
  x = addVersion(x, "AI draft, checked by the AI agent", "AI agent");
  x = say(x, ...intro(x, checksOf(x)));
  return logged(x, "AI agent", "Sent to clinician", x.flags.length + " open questions");
}

/** A clinician edit (table or assistant). The agent re-fixes cited pages after every edit. */
export function applyEdit(w: Workflow, item: ItemId, field: string, patch: Patch, by = "Clinician"): Workflow {
  expect(w, "clinician");
  const key = item + ":" + field;
  const fresh = w.lastKey !== key || ["remove", "restore", "order"].some(f => field.startsWith(f));
  let y: Workflow = { ...w, model: agentPass(applyPatch(w.model, patch), w.evidence, true).model, undo: fresh ? w.undo.concat([w.model]).slice(-30) : w.undo };
  if (fresh) {
    y = { ...y, rev: w.rev + 1 };
    y = addVersion(y, "Edited " + item, by);
    y = logged(y, by, "Edited " + item, field);
  } else {
    const v = y.versions.slice();
    v[v.length - 1] = { ...v[v.length - 1], meta: hashOf(y.model) + " · " + by + " · " + fmtTime(y.clock) };
    y.versions = v;
  }
  return { ...y, lastKey: key };
}

export function undoEdit(w: Workflow): Workflow {
  expect(w, "clinician");
  if (!w.undo.length) throw new Error("Nothing to undo");
  let y: Workflow = { ...w, model: w.undo[w.undo.length - 1], undo: w.undo.slice(0, -1), rev: w.rev + 1, lastKey: null };
  y = addVersion(y, "Undid last edit", "Clinician");
  return logged(y, "Clinician", "Undid last edit");
}

/** The written answer stored on the open question. The backend requires at least 15 characters and three words. */
export const resolutionText = (choice: "keep" | "change", note = "") =>
  note.trim().length >= 15 ? note.trim() : choice === "keep" ? "Kept as drafted: the clinician reviewed this question and agreed with the draft." : "Changed by the clinician in this version: see the edited rules.";

/** The clinician answers an open question: keep as drafted, or change it (they then edit the step).
    The answer is written into the logic model, so it travels with the version that is signed. */
export function answerFlag(w: Workflow, flagId: string, choice: "keep" | "change", note = ""): Workflow {
  expect(w, "clinician");
  const f = w.flags.find(z => z.id === flagId);
  if (!f) throw new Error("Question not found");
  const qid = flagId.slice(2);
  const model = w.model.open_questions.some(q => q.id === qid)
    ? applyPatch(applyPatch(w.model, { op: "set", path: ["open_questions", qid, "status"], value: "resolved" }), { op: "set", path: ["open_questions", qid, "resolution"], value: resolutionText(choice, note) })
    : w.model;
  const y: Workflow = { ...w, model, flags: w.flags.map(z => z.id === flagId ? { ...z, res: { choice, note, by: "Clinician" } } : z) };
  return logged(y, "Clinician", (choice === "keep" ? "Kept as drafted: " : "Will change: ") + qid, note);
}

/** A message to the assistant. Its reply may propose changes; nothing changes until the clinician applies one. */
export function chat(w: Workflow, text: string): Workflow {
  expect(w, "clinician");
  const t = text.trim();
  if (!t) return w;
  const y = say(w, { from: "clinician", text: t });
  if (/^\s*undo\b/i.test(t)) {
    if (!w.undo.length) return say(y, { from: "agent", text: "There is no edit to undo." });
    return say(undoEdit(y), { from: "agent", text: "Undone. The flow and the checks now show the version before your last edit." });
  }
  return say(y, respond(y, checksOf(y), t));
}

export function applyProposal(w: Workflow, msgId: number, i: number): Workflow {
  const m = w.chat.find(c => c.id === msgId), p = m?.proposals?.[i];
  if (!m || !p || p.state !== "open") throw new Error("Nothing to apply");
  let y = applyEdit(w, p.item, p.field + ":assistant:" + msgId, p.patch);
  y = { ...y, chat: y.chat.map(c => c.id === msgId ? { ...c, proposals: c.proposals!.map((q, k) => ({ ...q, state: k === i ? "applied" : q.state === "open" ? "dismissed" : q.state })) } : c) };
  y = logged(y, "Clinician", "Applied assistant change", p.label);
  return say(y, { from: "agent", text: "Applied: " + p.label + ". The flow and the checks are updated. Type \"undo\" to revert.", select: p.item });
}
export function dismissProposal(w: Workflow, msgId: number): Workflow {
  return { ...w, chat: w.chat.map(c => c.id === msgId ? { ...c, proposals: c.proposals?.map(q => q.state === "open" ? { ...q, state: "dismissed" as const } : q) } : c) };
}

/** `locked`: live mode, the backend version both signatures locked. */
export function approveAll(w: Workflow, locked?: { n: number; modelSha: string }): Workflow {
  expect(w, "clinician");
  const g = gate(w, checksOf(w));
  if (g.blockIds.length) throw new Error("Blocking checks are open");
  if (g.asks.length) throw new Error("Open questions are not answered");
  let y: Workflow = { ...w, state: "verify", approved: { ver: locked ? "v" + locked.n : "v4." + (w.rev || 0), hash: locked ? locked.modelSha.slice(0, 12) : hashOf(w.model), ...(locked ? { locked } : {}) } };
  y = addVersion(y, "Approved by clinician", "Clinician");
  if (locked) y = logged(y, "AI agent", "Signed as program officer (version " + locked.n + ")", "modelSha " + locked.modelSha.slice(0, 12));
  return logged(y, "Clinician", locked ? "Signed; version " + locked.n + " locked on the backend" : "Approved", "Approval bound to " + y.approved!.hash);
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
