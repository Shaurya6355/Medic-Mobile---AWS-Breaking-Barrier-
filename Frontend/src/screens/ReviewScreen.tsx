import { useState } from "react";
import { Link } from "react-router-dom";
import { V3, hashOf, same } from "../domain/data";
import { allItems, changedVs, getQ, nodeSig, nodeTitle, qStatus, srcOf } from "../domain/logic";
import { verLabel } from "../domain/workflow";
import type { Check, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Flow, type Markers, type Tone } from "../components/Flow";
import { Tray } from "../components/Tray";
import { Facts, NodeEditor, QuestionsRead } from "../components/NodeEditor";
import { ReviewControls } from "../components/ReviewControls";
import { FeedbackCard } from "../components/FeedbackCard";
import { ChecksPanel, FlagsPanel } from "../components/panels";
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
  if (w.state === "clinician" && role === "clinician") banner = "Click a box marked To review. Approve it, or request a change; you can't edit. The next box opens after each decision.";
  if (w.state === "po_revise" && role === "po") banner = "Boxes marked Change requested carry the clinician's feedback and an AI suggestion. Open each one and accept, edit or discard it.";
  if (!banner && ["po_draft", "clinician", "po_revise"].includes(w.state)) { banner = "Read-only for your role. Editing is locked while it is with someone else."; bcls = "banner muted"; }
  if (w.approved) { banner = "Content approved by the clinician: " + w.approved.ver + " · " + w.approved.hash + "."; bcls = "banner good"; }

  const r = w.reviews[sel];
  const src = srcOf(m, sel);
  return (
    <>
      <div className="top">
        <div>
          <h1>{title}</h1>
          <div className="ver">{verLabel(w) + " · " + hashOf(m) + " · " + nChanged + " steps changed · " + qAdded + " question" + (qAdded === 1 ? "" : "s") + " added · " + qRemoved + " removed · " + m.meta.pathway_id + " spec v" + m.meta.version}</div>
        </div>
      </div>
      {banner ? <div className={bcls}>{banner}</div> : null}
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
              <p className="note" style={{ margin: "0 0 8px" }}>Read-only, drawn from the rule table{canEdit ? "; your edits there show here straight away" : ""}. Click a box to see its details. Scroll to zoom, drag to pan.</p>
              <Flow m={m} selected={sel} onSelect={setSel} markers={mk} tone={tone} label="Decision flow (read-only)" />
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
          <section className="panel editor" aria-labelledby="np-h">
            <div className="ph">
              <h2 id="np-h">{nodeTitle(sel)}</h2>
              <span className="badges">{(mk[sel] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}</span>
            </div>
            {w.state === "po_revise" ? <FeedbackCard w={w} id={sel} onSug={act.sug} /> : null}
            {canEdit ? <NodeEditor key={sel} m={m} id={sel} edit={act.edit} /> : <><Facts m={m} id={sel} /><QuestionsRead m={m} id={sel} /></>}
            <div className="quote">{"“" + src[0] + "”"}<small>{m.meta.guideline.publisher + ", " + m.meta.guideline.title + " · " + src[1]}</small></div>
            {canReview ? (
              <ReviewControls key={sel + ":" + w.round + ":" + (r ? r.status : "none")} id={sel}
                review={r && (r.round === w.round || r.status === "approved") ? r : null}
                required={w.required.includes(sel)} onDecide={d => act.decide(sel, d)} />
            ) : r && role !== "po" ? (
              <div className={"rv " + r.status}>{r.status === "approved" ? "Approved by the clinician, round " + r.round : "Change requested, round " + r.round + ": " + r.note}</div>
            ) : null}
          </section>
          <FlagsPanel w={w} role={role} onFlag={act.flag} onSelect={setSel} />
          <ChecksPanel checks={checks} m={m} onSelect={setSel} />
        </div>
      </div>
    </>
  );
}
