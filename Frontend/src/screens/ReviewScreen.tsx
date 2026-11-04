import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { V3, hashOf, same } from "../domain/data";
import { allItems, changedVs, getQ, nodeSig, nodeTitle, qStatus, srcOf } from "../domain/logic";
import { clinicianSteps, todoItems, verLabel } from "../domain/workflow";
import type { Check, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Flow, type Markers, type Tone } from "../components/Flow";
import { Tray } from "../components/Tray";
import { Facts, NodeEditor, QuestionsRead } from "../components/NodeEditor";
import { ReviewControls } from "../components/ReviewControls";
import { FeedbackCard } from "../components/FeedbackCard";
import { ChecksPanel, FlagsPanel, StepFlags } from "../components/panels";
import { RuleTable } from "../components/RuleTable";

type View = "table" | "flow";
const VIEWS: [View, string][] = [["table", "Table"], ["flow", "Flow"]];
const readView = (): View => { try { return localStorage.getItem("reviewView") === "flow" ? "flow" : "table"; } catch { return "table"; } };

function markersFor(w: Workflow, role: Role, checks: Check[]) {
  const mk: Markers = {}, tone: Tone = {};
  const add = (id: string, cls: string, label: string) => { (mk[id] = mk[id] || []).push([cls, label]); };
  const m = w.model;
  allItems(m, V3, w.draft).forEach(id => {
    if (!id.startsWith("q:") && changedVs(m, id)) { tone[id] = "changed"; add(id, "changed", "Changed"); }
    if ((w.state === "po_draft" || w.state === "po_revise") && role === "po" && !same(nodeSig(m, id), nodeSig(w.draft, id))) add(id, "ed", "Edited");
    const r = w.reviews[id];
    if (r?.status === "approved") add(id, "ok", "Approved");
    else if (r?.status === "changes" && r.round === w.round) {
      const s = w.sug[id];
      const resolved = w.state === "po_revise" && ((s && (s.outcome === "accepted" || s.outcome === "edited")) || w.fixed[id]);
      if (resolved) add(id, "ok", "Resolved"); else add(id, "req", "Change requested");
    } else if (w.state === "clinician" && w.required.includes(id)) add(id, "todo", "To review");
  });
  checks.filter(c => c.sev === "blocking").forEach(c => { tone[c.id] = "bad"; });
  return { mk, tone };
}

interface Props { w: Workflow | null; role: Role; sel: string; setSel: (id: string) => void; act: Actions; checks: Check[] }

export function ReviewScreen({ w, role, sel, setSel, act, checks }: Props) {
  const [view, setView] = useState<View>(readView);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("reviewView", v); } catch { /* per-viewer convenience only */ } };
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
  if (w.state === "po_draft" && role === "po") banner = "Edit the rules in the table. Fix every row marked Edit required and look at each Check; the flow is redrawn from the table. Changed means it differs from the live version.";
  if (w.state === "clinician" && role === "clinician") banner = "One step at a time: approve it or request a change, and the next step opens. Previous and Next move freely.";
  if (w.state === "po_revise" && role === "po") banner = "Rows marked Change requested carry the clinician's feedback and an AI suggestion. Open each one and accept, edit or discard it.";
  if (!banner && ["po_draft", "clinician", "po_revise"].includes(w.state)) { banner = "Read-only for your role. Editing is locked while it is with someone else."; bcls = "banner muted"; }
  if (w.approved) { banner = "Content approved by the clinician: " + w.approved.ver + " · " + w.approved.hash + "."; bcls = "banner good"; }

  const r = w.reviews[sel];
  const todo = todoItems(w, role, checks);
  const goNext = () => { const i = todo.indexOf(sel); setSel(todo[(i + 1) % todo.length] ?? todo[0]); };
  const stepMode = canReview;
  const quote = (id: string) => { const q = srcOf(m, id); return <div className="quote">{"“" + q[0] + "”"}<small>{m.meta.guideline.publisher + ", " + m.meta.guideline.title + " · " + q[1]}</small></div>; };

  return (
    <>
      <div className="top">
        <div>
          <h1>{title}</h1>
          <div className="ver">{verLabel(w) + " · " + hashOf(m) + " · " + nChanged + " steps changed · " + qAdded + " question" + (qAdded === 1 ? "" : "s") + " added · " + qRemoved + " removed · " + m.meta.pathway_id + " spec v" + m.meta.version}</div>
        </div>
      </div>
      {banner ? <div className={bcls}>{banner}</div> : null}

      {stepMode ? <StepCard w={w} sel={sel} setSel={setSel} act={act} mk={mk} quote={quote} /> : null}

      <section className="panel">
        <div className="ph">
          <h2>{view === "flow" ? "Decision flow" : "Rules · " + m.rules.length}</h2>
          <div className="viewtgl" role="group" aria-label="View">
            {VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => pickView(k)}>{l}</button>)}
          </div>
        </div>
        {view === "table"
          ? <RuleTable w={w} canEdit={canEdit} checks={checks} sel={sel} onSelect={setSel} edit={act.edit} markers={mk} />
          : <>
              <p className="note" style={{ margin: "0 0 8px" }}>Read-only, drawn from the rule table. The flow zooms to the step you are on and fades the rest. Scroll to zoom, drag to pan.</p>
              <Flow m={m} selected={sel} onSelect={setSel} markers={mk} tone={tone} label="Decision flow (read-only)"
                next={canEdit || canReview ? { onNext: goNext, left: todo.length } : null} />
            </>}
      </section>

      <div className="editgrid">
        <section className="panel">
          <Tray m={m} selected={sel} onSelect={setSel} markers={mk} />
          <div className="legend">
            <span><span className="badge changed">Changed</span> differs from live</span>
            {role === "po" ? <span><span className="badge ed">Edited</span> by you</span> : null}
            <span><span className="badge todo">To review</span></span>
            <span><span className="badge ok">Approved</span></span>
            <span><span className="badge req">Change requested</span></span>
            <span><i className="sw" style={{ borderColor: "var(--del)" }} />blocking check</span>
          </div>
        </section>

        <div className="rightcol">
          {!stepMode ? (
            <section className="panel editor" aria-labelledby="np-h">
              <div className="ph">
                <h2 id="np-h">{nodeTitle(sel)}</h2>
                <span className="badges">{(mk[sel] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
              </div>
              {w.state === "po_revise" ? <FeedbackCard w={w} id={sel} onSug={act.sug} /> : null}
              {canEdit ? <NodeEditor key={sel} m={m} id={sel} edit={act.edit} onRemoved={() => setSel("scope")} /> : <><Facts m={m} id={sel} /><QuestionsRead m={m} id={sel} /></>}
              {quote(sel)}
              <StepFlags w={w} role={role} id={sel} onFlag={act.flag} />
              {r && role !== "po" ? (
                <div className={"rv " + r.status}>{r.status === "approved" ? "Approved by the clinician, round " + r.round : "Change requested, round " + r.round + ": " + r.note}</div>
              ) : null}
              {canEdit && todo.length ? <button type="button" className="btn primary" onClick={goNext}>{"Next item ▶ (" + todo.length + " left)"}</button> : null}
            </section>
          ) : null}
          <FlagsPanel w={w} role={role} onFlag={act.flag} onSelect={setSel} sel={sel} />
          <ChecksPanel checks={checks} m={m} onSelect={setSel} />
        </div>
      </div>
    </>
  );
}

/** The clinician's review as one step at a time: what changed, the guideline quote, any flags, and the decision. Next moves on. */
function StepCard({ w, sel, setSel, act, mk, quote }: { w: Workflow; sel: string; setSel: (id: string) => void; act: Actions; mk: Markers; quote: (id: string) => React.ReactNode }) {
  const steps = clinicianSteps(w);
  const ref = useRef<HTMLElement>(null);
  const at = Math.max(0, steps.indexOf(sel));
  const id = steps[at];
  useEffect(() => { if (id && id !== sel) setSel(id); }, [id, sel, setSel]);
  useEffect(() => { ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [id]);
  if (!id) return <div className="banner">Nothing was sent to you in this round.</div>;
  const r = w.reviews[id];
  const decided = (x: string) => (w.reviews[x]?.round === w.round || w.reviews[x]?.status === "approved") && !w.flags.some(f => f.about === x && f.clinical && !f.res);
  const done = steps.filter(decided).length;
  const firstOpen = steps.find(x => x !== id && !decided(x));
  return (
    <section ref={ref} className="panel stepcard" aria-labelledby="sc-h">
      <div className="ph">
        <div>
          <div className="note">{"Step " + (at + 1) + " of " + steps.length + " · " + done + " decided"}</div>
          <h2 id="sc-h">{nodeTitle(id)}</h2>
        </div>
        <div className="btnrow">
          <button type="button" className="btn" disabled={at === 0} onClick={() => setSel(steps[at - 1])}>{"◀ Previous"}</button>
          {at < steps.length - 1
            ? <button type="button" className="btn primary" onClick={() => setSel(steps[at + 1])}>{"Next ▶"}</button>
            : firstOpen ? <button type="button" className="btn primary" onClick={() => setSel(firstOpen)}>{"First open step ▶"}</button>
            : <button type="button" className="btn primary" disabled>{"All steps decided"}</button>}
        </div>
      </div>
      <div className="progress" aria-hidden="true"><i style={{ width: (100 * done / steps.length) + "%" }} /></div>
      <span className="badges">{(mk[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
      <div className="stepgrid">
        <div>
          <Facts m={w.model} id={id} />
          {quote(id)}
          <details className="qdetails"><summary>Questions this step reads</summary><QuestionsRead m={w.model} id={id} /></details>
        </div>
        <div>
          <StepFlags w={w} role="clinician" id={id} onFlag={act.flag} />
          <ReviewControls key={id + ":" + w.round + ":" + (r ? r.status : "none")} id={id}
            review={r && (r.round === w.round || r.status === "approved") ? r : null}
            required={w.required.includes(id)} onDecide={d => act.decide(id, d)} />
        </div>
      </div>
    </section>
  );
}
