import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { allItems, nodeSig } from "../domain/logic";
import { gate, verLabel } from "../domain/workflow";
import { checkStages } from "../domain/checks";
import type { Check, CheckKey, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Flow, type Markers, type Tone } from "../components/Flow";
import { CheckBar } from "../components/Checks";
import { GoldenCases } from "../components/Golden";
import { Chat } from "../components/Chat";
import { RuleTable } from "../components/RuleTable";

type Tab = "view" | "edit";
const readTab = (): Tab => { try { return localStorage.getItem("reviewTab") === "edit" ? "edit" : "view"; } catch { return "view"; } };
/** The assistant shows by default in View; in Edit it starts hidden so the table and the live flow get the width. */
const readChat = (t: Tab): boolean => { try { const v = localStorage.getItem("chat-" + t); return v === null ? t === "view" : v === "1"; } catch { return t === "view"; } };
const hashCheck = () => (location.hash.match(/^#check-(\w+)/)?.[1] as CheckKey | undefined) ?? null;

/** Yellow: a question waiting for the clinician. Red: a blocking check. Badge: edited since the agent's hand-over. */
function markersFor(w: Workflow, checks: Check[]) {
  const mk: Markers = {}, tone: Tone = {};
  const add = (id: string, cls: string, label: string) => { (mk[id] = mk[id] || []).push([cls, label]); };
  allItems(w.model, w.draft).forEach(id => { if (nodeSig(w.model, id) !== nodeSig(w.draft, id)) add(id, "ed", "Edited"); });
  w.flags.filter(f => !f.res).forEach(f => { tone[f.about] = "open"; add(f.about, "fl", "Question"); });
  checks.filter(c => c.sev === "blocking").forEach(c => { tone[c.id] = "bad"; });
  return { mk, tone };
}

export function ReviewScreen({ w, role, sel, setSel, act, checks }: { w: Workflow | null; role: Role; sel: string; setSel: (id: string) => void; act: Actions; checks: Check[] }) {
  const [tab, setTabRaw] = useState<Tab>(readTab);
  const [chatOnBy, setChatRaw] = useState<Record<Tab, boolean>>(() => ({ view: readChat("view"), edit: readChat("edit") }));
  const [openCheck, setOpenCheck] = useState<CheckKey | null>(hashCheck);
  const [approving, setApproving] = useState(false);
  const setTab = (t: Tab) => { setTabRaw(t); try { localStorage.setItem("reviewTab", t); } catch { /* private mode */ } };
  const chatOn = chatOnBy[tab];
  const setChat = (on: boolean) => { setChatRaw(x => ({ ...x, [tab]: on })); try { localStorage.setItem("chat-" + tab, on ? "1" : "0"); } catch { /* private mode */ } };
  useEffect(() => {
    const on = () => setOpenCheck(hashCheck());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (!w || w.state === "none") return <div className="banner">No workflow yet. Start one from a guideline on <Link to="/guidelines">Guidelines</Link>.</div>;

  const canEdit = role === "clinician" && w.state === "clinician";
  const stages = checkStages(w.model, w.evidence);
  const g = gate(w, checks);
  const { mk, tone } = markersFor(w, checks);
  const edited = Object.values(mk).filter(l => l.some(([c]) => c === "ed")).length;
  const edit = (item: string, field: string, patch: Parameters<Actions["edit"]>[2]) => act.edit(item, field, patch);
  const toEdit = (about: string) => { setSel(about); setTab("edit"); setChatRaw(x => ({ ...x, edit: true })); };
  const why = g.blockIds.length ? g.blockIds.length + " blocking check problem" + (g.blockIds.length > 1 ? "s" : "") + " to fix first"
    : g.asks.length ? g.asks.length + " open question" + (g.asks.length > 1 ? "s" : "") + " to answer in the assistant" : "";

  return (
    <div className="rv">
      <div className="rvhead">
        <div>
          <h1>{w.guideline?.pathway ?? "Pathway"}</h1>
          <div className="ver">{(w.guideline?.name ?? "") + " · " + verLabel(w) + (w.state !== "clinician" ? " · approved, read-only" : "")}</div>
        </div>
        <div className="vtabs" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={tab === "view"} onClick={() => setTab("view")}>View</button>
          <button type="button" role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")}>
            Edit{edited ? <span className="tcount" aria-label={edited + " edited"}>{edited}</span> : null}
          </button>
        </div>
        <div className="rvact">
          {!chatOn ? <button type="button" className="btn" onClick={() => setChat(true)}>Assistant{g.asks.length ? " (" + g.asks.length + ")" : ""}</button> : null}
          {canEdit ? (
            <>
              {tab === "edit" ? <button type="button" className="btn" disabled={!w.undo.length} onClick={act.undo}>Undo</button> : null}
              <button type="button" className="btn primary" disabled={!g.ready || approving} title={why || "Approve this version and send it to the IT approver"}
                onClick={async () => { setApproving(true); try { await act.approveAll(); } finally { setApproving(false); } }}>
                {approving ? <><span className="spin" aria-hidden="true" />Saving and signing...</> : "Approve and send to IT"}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {canEdit && why ? <div className="note rvwhy">{why[0].toUpperCase() + why.slice(1) + "."}</div> : null}

      <CheckBar stages={stages} open={openCheck} setOpen={k => { setOpenCheck(k); if (!k && location.hash) history.replaceState(null, "", location.pathname + location.search); }} onSelect={setSel} />

      <div className={"rvbody" + (chatOn ? "" : " nochat")}>
        {tab === "view" ? (
          <div className="rvmain tabpane" key="view">
            {edited ? (
              <div className="rvtip">
                <span className="dotc" aria-hidden="true" />
                {edited + " step" + (edited > 1 ? "s" : "") + " edited since the AI hand-over, marked Edited in the flowchart."}
                {canEdit ? <button type="button" className="linkb" onClick={() => setTab("edit")}>Back to the table</button> : null}
              </div>
            ) : null}
            <section className="panel flowpanel">
              <Flow m={w.model} selected={sel === "scope" ? undefined : sel} onSelect={setSel} markers={mk} tone={tone} label="Decision flow" />
            </section>
            <section className="panel"><GoldenCases m={w.model} onSelect={setSel} /></section>
          </div>
        ) : (
          <div className="rvedit tabpane" key="edit">
            <div className="rvtip">
              {canEdit ? "Edit any cell. The flowchart, test patients and checks update as you type; open View to see them." : "Read-only" + (role !== "clinician" ? " for your role." : ".")}
              <button type="button" className="linkb" onClick={() => setTab("view")}>{edited ? "See " + edited + " change" + (edited > 1 ? "s" : "") + " in the flowchart" : "Open the flowchart"}</button>
            </div>
            <section className="panel">
              <RuleTable w={w} canEdit={canEdit} checks={checks} sel={sel} onSelect={setSel} edit={edit} markers={mk} />
            </section>
          </div>
        )}
        {chatOn ? <Chat w={w} act={act} canAct={canEdit} onSelect={id => { setSel(id); }} onChange={toEdit} onClose={() => setChat(false)} /> : null}
      </div>
    </div>
  );
}
