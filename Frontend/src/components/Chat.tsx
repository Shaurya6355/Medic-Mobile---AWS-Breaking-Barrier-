import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMsg, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import type { ItemScore } from "../domain/scores";
import { QuestionScoreNote } from "./QuoteScores";

const TRY = ["What happens to a 2 year old breathing 45 a minute?", "Explain R3", "Change 40 to 45", "Which checks have problems?"];

/** One open question at a time, as a card: the question, the guideline passage, two big answers. */
function QuestionCard({ w, act, canAct, onSelect, onChange, scores }: { w: Workflow; act: Actions; canAct: boolean; onSelect: (id: string) => void; onChange: (about: string) => void; scores?: Map<string, ItemScore> }) {
  const total = w.flags.length, done = w.flags.filter(f => f.res).length;
  const f = w.flags.find(x => !x.res);
  if (!total) return null;
  if (!f) return <div className="qdone"><span aria-hidden="true">✓</span>{"All " + total + " questions answered"}</div>;
  return (
    <section className="qcard" aria-label={"Question " + (done + 1) + " of " + total}>
      <div className="qhead">
        <span className="qnum">{"Question " + (done + 1) + " of " + total}</span>
        <span className="qbar" aria-hidden="true"><i style={{ width: (100 * done / total) + "%" }} /></span>
      </div>
      <p className="qtext">{f.title}</p>
      {f.src !== "No guideline passage" ? <blockquote className="qquote">{f.src}</blockquote> : <p className="note">The guideline does not answer this; it is your call.</p>}
      <QuestionScoreNote v={scores?.get(f.about)} />
      <div className="qbtns">
        <button type="button" className="btn primary" disabled={!canAct} onClick={() => act.answer(f.id, "keep")}>Keep it</button>
        <button type="button" className="btn" disabled={!canAct} onClick={() => { act.answer(f.id, "change"); onChange(f.about); }}>Change it</button>
      </div>
      <button type="button" className="lnk" onClick={() => onSelect(f.about)}>Show it on the flowchart</button>
    </section>
  );
}

function Ask({ w, id, act, canAct, onChange }: { w: Workflow; id: string; act: Actions; canAct: boolean; onChange: (about: string) => void }) {
  const f = w.flags.find(x => x.id === id);
  if (!f) return null;
  if (f.res) return <div className="cans">{f.res.choice === "keep" ? "✓ Kept as drafted" : "✎ You chose to change this"}</div>;
  return (
    <div className="cbtns">
      <span className="note">{f.src}</span>
      <div className="btnrow">
        <button type="button" className="btn tiny ok" disabled={!canAct} onClick={() => act.answer(f.id, "keep")}>Keep as drafted</button>
        <button type="button" className="btn tiny" disabled={!canAct} onClick={() => { act.answer(f.id, "change"); onChange(f.about); }}>Change it</button>
      </div>
    </div>
  );
}

function Msg({ m, w, act, canAct, onSelect, onChange }: { m: ChatMsg; w: Workflow; act: Actions; canAct: boolean; onSelect: (id: string) => void; onChange: (about: string) => void }) {
  const open = m.proposals?.some(p => p.state === "open");
  return (
    <li className={"cmsg " + m.from + (m.ask ? " ask" : "")}>
      {m.ask ? <span className="ctag">{"Question " + m.ask.slice(2)}</span> : null}
      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
      {m.proposals?.length ? (
        <ul className="cprops">
          {m.proposals.map((p, i) => (
            <li key={i} className={"cprop " + p.state}>
              <div className="mono">{p.label}</div>
              <div className="note">{p.impact}</div>
              {p.state === "open" ? <button type="button" className="btn tiny primary" disabled={!canAct} onClick={() => act.apply(m.id, i)}>Apply</button>
                : <span className="note">{p.state === "applied" ? "✓ Applied" : "Not applied"}</span>}
            </li>
          ))}
          {open ? <li><button type="button" className="lnk" disabled={!canAct} onClick={() => act.dismiss(m.id)}>Dismiss</button></li> : null}
        </ul>
      ) : null}
      {m.revision ? (
        <div className="cbtns">
          {m.revision.state === "ready" ? (
            <div className="btnrow">
              <button type="button" className="btn tiny primary" disabled={!canAct} onClick={() => act.confirmRevision(m.id)}>Confirm and apply</button>
              <button type="button" className="btn tiny" disabled={!canAct} onClick={() => act.cancelRevision(m.id)}>Cancel</button>
            </div>
          ) : <span className="note">{{ applying: "Working on it… (the AI edits, then the checks and the officer agent run)", applied: "✓ Applied", no_change: "No change made", failed: "Did not finish", cancelled: "Cancelled", ready: "" }[m.revision.state]}</span>}
        </div>
      ) : null}
      {m.ask ? <Ask w={w} id={m.ask} act={act} canAct={canAct} onChange={onChange} /> : null}
      {m.select ? <button type="button" className="lnk cshow" onClick={() => onSelect(m.select!)}>Show on flow</button> : null}
    </li>
  );
}

/** The assistant beside the flow: answers questions about the rules and proposes changes the clinician applies. */
/** `scores` adds the weak-quote line to the question card; `item` (the selected item's quote support) sits under it. */
export function Chat({ w, act, canAct, onSelect, onChange, onClose, scores, item }: { w: Workflow; act: Actions; canAct: boolean; onSelect: (id: string) => void; onChange: (about: string) => void; onClose: () => void; scores?: Map<string, ItemScore>; item?: ReactNode }) {
  const [text, setText] = useState("");
  const log = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [w.chat.length]);
  const send = (t: string) => { if (t.trim()) { act.chat(t); setText(""); } };
  return (
    <aside className="chat panel" aria-label="Assistant">
      <div className="chath">
        <b>Assistant</b>
        <span className="note" />
        <button type="button" className="lnk" onClick={onClose} aria-label="Hide assistant">Hide</button>
      </div>
      <div className="chat-top">
        <QuestionCard w={w} act={act} canAct={canAct} onSelect={onSelect} onChange={onChange} scores={scores} />
        {item}
      </div>
      <ol className="clog" ref={log}>
        {w.chat.filter(m => !m.ask).map(m => <Msg key={m.id} m={m} w={w} act={act} canAct={canAct} onSelect={onSelect} onChange={onChange} />)}
      </ol>
      {canAct ? (
        <>
          <div className="ctry">{TRY.map(t => <button key={t} type="button" className="chipb" onClick={() => send(t)}>{t}</button>)}</div>
          <form className="cin" onSubmit={e => { e.preventDefault(); send(text); }}>
            <label className="sr" htmlFor="chat-in">Message the assistant</label>
            <textarea id="chat-in" rows={3} value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
              placeholder="Ask about a patient, a rule or the guideline, or describe a change. Enter sends, Shift+Enter adds a line." />
            <div className="cact">
              <button type="submit" className="btn primary" disabled={!text.trim()}>Send</button>
              {w.remote ? <button type="button" className="btn" disabled={!text.trim()} title="Save this as a comment and ask the AI to revise the logic model. You confirm the plan before anything changes." onClick={() => { act.feedback(text); setText(""); }}>Send as feedback</button> : null}
            </div>
          </form>
        </>
      ) : <p className="note">Read-only: only the clinician talks to the assistant.</p>}
    </aside>
  );
}
