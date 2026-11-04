import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { V3, hashOf, same } from "../domain/data";
import { allItems, changedVs, getQ, itemLabel, nodeSig, nodeTitle, qStatus, srcOf } from "../domain/logic";
import { checksOf, clinicianSteps, flagsFor, gate, todoItems, verLabel } from "../domain/workflow";
import type { Check, CheckKey, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Flow, type Markers, type Tone } from "../components/Flow";
import { Tray } from "../components/Tray";
import { Facts, NodeEditor, QuestionsRead } from "../components/NodeEditor";
import { ReviewControls } from "../components/ReviewControls";
import { FeedbackCard } from "../components/FeedbackCard";
import { FlagsPanel, StepFlags } from "../components/panels";
import { CheckLink, CheckPipeline, IssueLine } from "../components/Checks";
import { checkStages, STAGES } from "../domain/checks";
import { RuleTable } from "../components/RuleTable";

type View = "table" | "flow";
const VIEWS: [View, string][] = [["table", "Table"], ["flow", "Flow"]];
const readView = (): View => { try { return localStorage.getItem("reviewView") === "flow" ? "flow" : "table"; } catch { return "table"; } };

function markersFor(w: Workflow, role: Role, checks: Check[]) {
  const mk: Markers = {}, tone: Tone = {};
  const add = (id: string, cls: string, label: string) => { (mk[id] = mk[id] || []).push([cls, label]); };
  const m = w.model;
  allItems(m, V3, w.draft).forEach(id => {
    if (!id.startsWith("q:") && changedVs(m, id)) add(id, "changed", "Changed");
    if ((w.state === "po_draft" || w.state === "po_revise") && role === "po" && !same(nodeSig(m, id), nodeSig(w.draft, id))) add(id, "ed", "Edited");
    const r = w.reviews[id];
    if (r?.status === "approved") add(id, "ok", "Approved");
    else if (r?.status === "changes" && r.round === w.round) {
      const s = w.sug[id];
      const resolved = w.state === "po_revise" && ((s && (s.outcome === "accepted" || s.outcome === "edited")) || w.fixed[id]);
      if (resolved) add(id, "ok", "Resolved"); else add(id, "req", "Change requested");
    } else if (w.state === "clinician" && w.required.includes(id)) add(id, "todo", "To review");
  });
  // Yellow = open for this role; red edge = blocking check. "Changed" stays a badge only, so yellow means one thing.
  todoItems(w, role, checks).forEach(id => { tone[id] = "open"; });
  checks.filter(c => c.sev === "blocking").forEach(c => { tone[c.id] = "bad"; });
  return { mk, tone };
}

type Tab = "open" | "step" | "questions" | "checks";
interface Props { w: Workflow | null; role: Role; sel: string; setSel: (id: string) => void; act: Actions; checks: Check[] }

export function ReviewScreen({ w, role, sel, setSel, act, checks }: Props) {
  const [view, setView] = useState<View>(readView);
  const [tab, setTab] = useState<Tab>("open");
  // Checks are links: #check-<key> opens the Checks tab with that check expanded.
  const [openCheck, setOpenCheck] = useState<CheckKey | null>(null);
  useEffect(() => {
    const read = () => {
      const k = location.hash.match(/^#check-(\w+)$/)?.[1] as CheckKey | undefined;
      if (k && STAGES.some(s => s.key === k)) { setTab("checks"); setOpenCheck(k); }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("reviewView", v); } catch { /* per-viewer convenience only */ } };
  const steps = w ? clinicianSteps(w) : [];
  const stepKey = w ? w.state + ":" + w.round + ":" + role : "";
  // The clinician starts on their first step.
  useEffect(() => {
    const clin = !!w && role === "clinician" && w.state === "clinician";
    setTab(clin ? "step" : "open");
    if (clin && steps[0]) setSel(steps[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey]);
  if (!w || w.state === "none") return <div className="banner">No workflow yet. The program officer creates one from <Link to="/guidelines">Guidelines</Link>.</div>;
  const m = w.model;
  const canEdit = role === "po" && (w.state === "po_draft" || w.state === "po_revise");
  const canReview = role === "clinician" && w.state === "clinician";
  const { mk, tone } = markersFor(w, role, checks);
  const nChanged = allItems(m, V3).filter(id => !id.startsWith("q:") && changedVs(m, id)).length;
  const qAdded = m.questions.filter(q => qStatus(m, q.id) === "added").length;
  const qRemoved = V3.questions.filter(q => !getQ(m, q.id)).length;
  const title = role === "clinician" ? "Clinical review" + (w.round ? " · round " + w.round : "") : role === "it" ? "Workflow (read-only)" : "Program officer workflow";

  let banner: string | null = null, bcls = "banner";
  if (w.state === "po_draft" && role === "po") banner = "Work through Open items on the right: each one opens its step and the flow zooms to it. Yellow boxes are open, a red edge is a blocking check.";
  if (w.state === "clinician" && role === "clinician") banner = "One step at a time on the right: approve it (no note needed) or request a change, and the next step opens.";
  if (w.state === "po_revise" && role === "po") banner = "Each open item carries the clinician's feedback. Accept the suggestion, type the change yourself, or edit the step.";
  if (!banner && ["po_draft", "clinician", "po_revise"].includes(w.state)) { banner = "Read-only for your role. Editing is locked while it is with someone else."; bcls = "banner muted"; }
  if (w.approved) { banner = "Content approved by the clinician: " + w.approved.ver + " · " + w.approved.hash + "."; bcls = "banner good"; }

  const todo = todoItems(w, role, checks);
  const pick = (id: string) => { setSel(id); setTab("step"); };
  const goNext = () => { const i = todo.indexOf(sel); pick(todo[(i + 1) % todo.length] ?? todo[0]); };
  const quote = (id: string) => { const q = srcOf(m, id); return <div className="quote">{"“" + q[0] + "”"}<small>{m.meta.guideline.publisher + ", " + m.meta.guideline.title + " · " + q[1]}</small></div>; };
  const stages = checkStages(m, w.evidence);
  const nFailed = stages.filter(s => s.status === "fail").length;
  const TABS: [Tab, string][] = [["open", "Open items" + (todo.length ? " (" + todo.length + ")" : "")], ["step", "Step"], ["questions", "Questions"], ["checks", "Checks" + (nFailed ? " (" + nFailed + " failed)" : "")]];

  return (
    <>
      <div className="top">
        <div>
          <h1>{title}</h1>
          <div className="ver">{verLabel(w) + " · " + hashOf(m) + " · " + nChanged + " steps changed · " + qAdded + " question" + (qAdded === 1 ? "" : "s") + " added · " + qRemoved + " removed · " + m.meta.pathway_id + " spec v" + m.meta.version}</div>
        </div>
      </div>
      {banner ? <div className={bcls}>{banner}</div> : null}

      <div className="split">
        <section className="panel">
          <div className="ph">
            <h2>{view === "flow" ? "Decision flow" : "Rules · " + m.rules.length}</h2>
            <div className="viewtgl" role="group" aria-label="View">
              {VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => pickView(k)}>{l}</button>)}
            </div>
          </div>
          {view === "table"
            ? <RuleTable w={w} canEdit={canEdit} checks={checks} sel={sel} onSelect={pick} edit={act.edit} markers={mk} />
            : <>
                <Flow m={m} selected={sel} onSelect={pick} markers={mk} tone={tone} label="Decision flow (read-only)"
                  next={canEdit || canReview ? { onNext: goNext, left: todo.length } : null} />
                <div className="legend">
                  <span><i className="sw" style={{ borderColor: "var(--chg)", background: "var(--chg-bg)" }} />open for you</span>
                  <span><i className="sw" style={{ borderColor: "var(--del)" }} />blocking check</span>
                  <span><span className="badge changed">Changed</span> differs from live</span>
                  <span className="note">Read-only, drawn from the rule table. Scroll to zoom, drag to pan.</span>
                </div>
              </>}
        </section>

        <aside className="panel inspector" aria-label="Inspector">
          <div className="itabs" role="tablist">
            {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === "open" ? <OpenItems w={w} role={role} checks={checks} todo={todo} steps={steps} sel={sel} pick={pick} setSel={setSel} act={act} />
            : tab === "questions" ? <Tray m={m} selected={sel} onSelect={pick} markers={mk} />
            : tab === "checks" ? <CheckPipeline stages={stages} open={openCheck} setOpen={setOpenCheck} onSelect={pick} />
            : canReview ? <StepCard w={w} steps={steps} sel={sel} setSel={setSel} act={act} mk={mk} quote={quote} />
            : (
              <div className="stack">
                <div className="ph">
                  <h2>{nodeTitle(sel)}</h2>
                  <span className="badges">{(mk[sel] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
                </div>
                {canEdit && todo.length ? <button type="button" className="btn primary" onClick={goNext}>{"Next item ▶ (" + todo.length + " left)"}</button> : null}
                {w.state === "po_revise" ? <FeedbackCard w={w} id={sel} onSug={act.sug} /> : null}
                <StepFlags w={w} role={role} id={sel} onFlag={act.flag} />
                <StepChecks checks={checks} id={sel} />
                {canEdit ? <NodeEditor key={sel} m={m} id={sel} edit={act.edit} onRemoved={() => setSel("scope")} /> : <><Facts m={m} id={sel} /><QuestionsRead m={m} id={sel} /></>}
                {quote(sel)}
                {w.reviews[sel] && role !== "po" ? (
                  <div className={"rv " + w.reviews[sel].status}>{w.reviews[sel].status === "approved" ? "Approved by the clinician, round " + w.reviews[sel].round : "Change requested, round " + w.reviews[sel].round + ": " + w.reviews[sel].note}</div>
                ) : null}
              </div>
            )}
        </aside>
      </div>
    </>
  );
}

/** Everything open for this role, one row per step with why it is open. Clicking opens the step and zooms the flow to it. */
function OpenItems({ w, role, checks, todo, steps, sel, pick, setSel, act }: { w: Workflow; role: Role; checks: Check[]; todo: string[]; steps: string[]; sel: string; pick: (id: string) => void; setSel: (id: string) => void; act: Actions }) {
  const g = gate(w, checks);
  const flags = flagsFor(w, role).filter(f => !f.res);
  const why = (id: string): React.ReactNode[] => [
    ...checks.filter(c => c.id === id && c.sev === "blocking").map(c => <>{"Fix · "}<CheckLink k={c.kind} />{": " + c.text}</>),
    ...(g.unresolved.includes(id) ? ["Clinician requested a change"] : []),
    ...(role === "clinician" && g.reqLeft.includes(id) ? ["Changed: approve or request a change"] : []),
    ...flags.filter(f => f.about === id && (role === "clinician" ? f.clinical : !f.clinical)).map(f => "Flag: " + f.title),
  ];
  const list = role === "clinician" && w.state === "clinician" ? steps : todo;
  const open = new Set(todo);
  return (
    <div className="stack">
      {list.length ? (
        <ol className="olist">
          {list.map(id => (
            <li key={id} className={"oitem" + (sel === id ? " sel" : "") + (open.has(id) ? " open" : " done")}>
              <button type="button" className="oh" onClick={() => pick(id)}>
                <b>{itemLabel(id)}</b><span className={"badge " + (open.has(id) ? "todo" : "ok")}>{open.has(id) ? "Open" : "Done"}</span>
              </button>
              {why(id).map((t, i) => <span key={i} className="note">{t}</span>)}
            </li>
          ))}
        </ol>
      ) : <div className="banner good">Nothing open for you right now.</div>}
      <FlagsPanel w={w} role={role} onFlag={act.flag} onSelect={setSel} sel={sel} />
    </div>
  );
}

/** The clinician's review as one step at a time: what changed, the guideline quote, any flags, and the decision. Next moves on. */
function StepCard({ w, steps, sel, setSel, act, mk, quote }: { w: Workflow; steps: string[]; sel: string; setSel: (id: string) => void; act: Actions; mk: Markers; quote: (id: string) => React.ReactNode }) {
  if (!steps.length) return <div className="banner">Nothing was sent to you in this round.</div>;
  const at = steps.indexOf(sel);
  if (at < 0) return (
    <div className="stack">
      <h2>{nodeTitle(sel)}</h2>
      <p className="note">Not sent to you in this round. Read-only.</p>
      <Facts m={w.model} id={sel} />
      <button type="button" className="btn primary" onClick={() => setSel(steps[0])}>{"Back to step 1 ▶"}</button>
    </div>
  );
  const id = steps[at];
  const r = w.reviews[id];
  const decided = (x: string) => (w.reviews[x]?.round === w.round || w.reviews[x]?.status === "approved") && !w.flags.some(f => f.about === x && f.clinical && !f.res);
  const done = steps.filter(decided).length;
  const firstOpen = steps.find(x => x !== id && !decided(x));
  return (
    <div className="stack stepcard">
      <div className="note">{"Step " + (at + 1) + " of " + steps.length + " · " + done + " decided"}</div>
      <div className="progress" aria-hidden="true"><i style={{ width: (100 * done / steps.length) + "%" }} /></div>
      <div className="btnrow">
        <button type="button" className="btn" disabled={at === 0} onClick={() => setSel(steps[at - 1])}>{"◀ Previous"}</button>
        {at < steps.length - 1
          ? <button type="button" className="btn primary" onClick={() => setSel(steps[at + 1])}>{"Next ▶"}</button>
          : firstOpen ? <button type="button" className="btn primary" onClick={() => setSel(firstOpen)}>{"First open step ▶"}</button>
          : <button type="button" className="btn primary" disabled>{"All steps decided"}</button>}
      </div>
      <h2>{nodeTitle(id)}</h2>
      <span className="badges">{(mk[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
      <ReviewControls key={id + ":" + w.round + ":" + (r ? r.status : "none")} id={id}
        review={r && (r.round === w.round || r.status === "approved") ? r : null}
        required={w.required.includes(id)} onDecide={d => act.decide(id, d)} />
      <StepFlags w={w} role="clinician" id={id} onFlag={act.flag} />
      <StepChecks checks={checksOf(w)} id={id} />
      <Facts m={w.model} id={id} />
      {quote(id)}
      <details className="qdetails"><summary>Questions this step reads</summary><QuestionsRead m={w.model} id={id} /></details>
    </div>
  );
}

/** The checks that found something on this step, each linked to its check. */
function StepChecks({ checks, id }: { checks: Check[]; id: string }) {
  const cs = checks.filter(c => c.id === id);
  if (!cs.length) return null;
  return (
    <div className="stepflags">
      <div className="lab">{cs.length === 1 ? "1 check found something here" : cs.length + " checks found something here"}</div>
      <ul className="clist">{cs.map((c, i) => <IssueLine key={i} c={c} />)}</ul>
    </div>
  );
}
