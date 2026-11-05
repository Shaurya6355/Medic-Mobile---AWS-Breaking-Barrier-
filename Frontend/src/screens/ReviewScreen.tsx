import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { allItems, nodeSig } from "../domain/logic";
import { gate, verLabel } from "../domain/workflow";
import { hashOf } from "../domain/data";
import { checkStages } from "../domain/checks";
import type { Check, CheckKey, Role, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { Flow, type Markers, type Tone } from "../components/Flow";
import { CheckBar } from "../components/Checks";
import { GoldenCases } from "../components/Golden";
import { Chat } from "../components/Chat";
import { RuleTable } from "../components/RuleTable";
import { Icon } from "../components/Icon";
import { SectionHead } from "../components/Page";
import { ItemQuoteCard } from "../components/QuoteScores";
import { readFirst, scoreBadge, scoreIndex, type ItemScore } from "../domain/scores";

type Tab = "view" | "edit";
const readTab = (): Tab => { try { return localStorage.getItem("reviewTab") === "edit" ? "edit" : "view"; } catch { return "view"; } };
/** The assistant shows by default in View; in Edit it starts hidden so the table and the live flow get the width. */
const readChat = (t: Tab): boolean => { try { const v = localStorage.getItem("chat-" + t); return v === null ? t === "view" : v === "1"; } catch { return t === "view"; } };
const hashCheck = () => (location.hash.match(/^#check-(\w+)/)?.[1] as CheckKey | undefined) ?? null;

/** Yellow: a question waiting for the clinician. Red: a blocking check. Badge: edited since the agent's hand-over.
    Quote badge: the quote check flagged this item's quote (advisory: a badge only, never a tone or a check). */
function markersFor(w: Workflow, checks: Check[], scores: Map<string, ItemScore>) {
  const mk: Markers = {}, tone: Tone = {};
  const add = (id: string, cls: string, label: string) => { (mk[id] = mk[id] || []).push([cls, label]); };
  allItems(w.model, w.draft).forEach(id => { if (nodeSig(w.model, id) !== nodeSig(w.draft, id)) add(id, "ed", "Edited"); });
  w.flags.filter(f => !f.res).forEach(f => { tone[f.about] = "open"; add(f.about, "fl", "Question"); });
  checks.filter(c => c.sev === "blocking").forEach(c => { tone[c.id] = "bad"; });
  scores.forEach(v => { const b = scoreBadge(v); if (b) add(v.id, b[0], b[1]); });
  return { mk, tone };
}

/** The high-emphasis card: what the AI agent handed over and what still stops approval. */
function HandOver({ ready, blocking, asks, ver, state, onAnswer, weak }: { ready: boolean; blocking: number; asks: number; ver: string; state: Workflow["state"]; onAnswer: () => void; weak?: { n: number; open: () => void } }) {
  const title = state !== "clinician" ? "Approved" : ready ? "Ready to approve" : asks ? asks + " question" + (asks > 1 ? "s" : "") + " for you" : blocking + " problem" + (blocking > 1 ? "s" : "") + " to fix";
  const desc = state !== "clinician" ? "This version is signed and read-only." : ready ? "Checks pass and every question is answered. Approve when the flow looks right." : asks ? "The AI agent needs your answer before this version can be approved. One at a time." : "Fix the blocking checks before approving this version.";
  return (
    <section className="score" aria-label="AI agent hand-over">
      <span className="score-k">AI agent hand-over</span>
      <h2 className="score-t">{title}</h2>
      <p className="score-d">{desc}</p>
      {state === "clinician" && asks ? <button type="button" className="score-btn" onClick={onAnswer}>{"Answer " + (asks > 1 ? "the questions" : "the question")}<Icon name="arrow_forward" size={18} /></button> : null}
      <dl className="score-rows">
        <div><dt>Blocking checks</dt><dd>{blocking}</dd></div>
        <div className={asks ? "accent" : ""}><dt>Open questions</dt><dd>{asks}</dd></div>
        {weak ? <div title="Advisory: quotes the scoring model thinks may not support their item. Not a check; never blocks approval.">
          <dt>Weak quotes</dt><dd>{weak.n ? <button type="button" className="score-link" onClick={weak.open}>{weak.n + " · read first"}</button> : "0"}</dd>
        </div> : null}
        <div><dt>Version</dt><dd className="mono">{ver}</dd></div>
      </dl>
      <Icon name="fact_check" size={120} className="score-wm" />
    </section>
  );
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
  const failing = stages.filter(x => x.status === "fail");
  const notes = stages.filter(x => x.status === "warn" || x.status === "missing").length;
  const light = failing.length ? { tone: "red", text: failing.length + " check" + (failing.length > 1 ? "s need" : " needs") + " you" }
    : notes ? { tone: "amber", text: "Checks passed · " + notes + " with notes to look at" }
    : { tone: "green", text: "All " + stages.length + " checks passed" };
  const g = gate(w, checks);
  const scores = scoreIndex(w.scores, w.model);
  const { mk, tone } = markersFor(w, checks, scores);
  const weak = readFirst(scores);
  const itemCard = <ItemQuoteCard s={w.scores} m={w.model} idx={scores} id={sel} />;
  const edited = Object.values(mk).filter(l => l.some(([c]) => c === "ed")).length;
  const edit = (item: string, field: string, patch: Parameters<Actions["edit"]>[2]) => act.edit(item, field, patch);
  const toEdit = (about: string) => { setSel(about); setTab("edit"); setChatRaw(x => ({ ...x, edit: true })); };
  const why = g.blockIds.length ? g.blockIds.length + " blocking check problem" + (g.blockIds.length > 1 ? "s" : "") + " to fix first"
    : g.asks.length ? g.asks.length + " open question" + (g.asks.length > 1 ? "s" : "") + " to answer in the assistant" : "";

  return (
    <div className="rv">
      <div className="rvhead">
        <div className="phead">
          <div className="eyebrow"><span className="eb-a">{"Logic model " + verLabel(w)}</span><span className="eb-sep" aria-hidden="true">•</span><span>{(w.guideline?.name ?? "") + (w.state !== "clinician" ? " · approved, read-only" : "")}</span></div>
          <h1 className="display">{w.guideline?.pathway ?? "Pathway"}</h1>
        </div>
        <div className="vtabs" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={tab === "view"} onClick={() => setTab("view")}>View</button>
          <button type="button" role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")}>
            Edit{edited ? <span className="tcount" aria-label={edited + " edited"}>{edited}</span> : null}
          </button>
        </div>
        <div className="rvact">
          {!chatOn ? <button type="button" className="btn" onClick={() => setChat(true)}><Icon name="forum" size={18} />Assistant</button> : null}
          {canEdit ? (
            <>
              {tab === "edit" ? <button type="button" className="btn" disabled={!w.undo.length} onClick={act.undo}><Icon name="undo" size={18} />Undo</button> : null}
              <button type="button" className="btn primary" disabled={!g.ready || approving} title={why || "Approve this version and send it to the IT approver"}
                onClick={async () => { setApproving(true); try { await act.approveAll(); } finally { setApproving(false); } }}>
                {approving ? <><span className="spin" aria-hidden="true" />Saving and signing...</> : <><Icon name="send" size={18} />Approve and send to IT</>}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <section className="checkbox" aria-label="Safety checks">
        <div className={"tlight " + light.tone}>
          <span className="tl-dot" aria-hidden="true" />
          <span className="tl-text"><b>Safety checks</b>{" · " + light.text}</span>
          <span className="note">Click a check for details</span>
        </div>
        <CheckBar stages={stages} open={openCheck} setOpen={k => { setOpenCheck(k); if (!k && location.hash) history.replaceState(null, "", location.pathname + location.search); }} onSelect={setSel} />
      </section>

      <div className={"rvbody" + (tab === "edit" && !chatOn ? " solo" : "")}>
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
              <SectionHead icon="account_tree" tone="teal" title="Decision flow" sub="Rules in priority order. The first rule that matches decides the outcome." />
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
              <SectionHead icon="table_view" tone="grey" title="Rule table" sub={canEdit ? "Edit any cell. Changes show in the View flowchart." : "Read-only."} />
              <RuleTable w={w} canEdit={canEdit} checks={checks} sel={sel} onSelect={setSel} edit={edit} markers={mk} />
            </section>
          </div>
        )}
        {tab === "edit" && !chatOn ? null : <div className="rvside">
          {tab === "view" ? <HandOver ready={g.ready} blocking={g.blockIds.length} asks={g.asks.length} ver={verLabel(w) + " · " + (w.approved?.hash ?? hashOf(w.model))} state={w.state} onAnswer={() => { setChat(true); setTimeout(() => document.querySelector(".qcard")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}
            weak={w.scores?.status === "scored" ? { n: weak.length, open: () => { if (weak[0]) { setSel(weak[0].id); setTimeout(() => document.querySelector(".qs-card")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); } } } : undefined} /> : null}
          {chatOn ? <Chat w={w} act={act} canAct={canEdit} onSelect={id => { setSel(id); }} onChange={toEdit} onClose={() => setChat(false)} scores={scores} item={itemCard} /> : itemCard}
        </div>}
      </div>
    </div>
  );
}
