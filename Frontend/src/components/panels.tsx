import { useState } from "react";
import { V3_HASH } from "../domain/data";
import { golden, grid, itemLabel } from "../domain/logic";
import { flagsFor } from "../domain/workflow";
import type { Check, Flag, Model, Role, Workflow } from "../domain/types";

type OnFlag = (id: string, choice: number, note: string) => void;


/** One flag as a card: what was raised, where it comes from, and the decision. */
export function FlagCard({ f, w, role, onFlag, onSelect, pos }: { f: Flag; w: Workflow; role: Role; onFlag: OnFlag; onSelect?: (id: string) => void; pos?: string }) {
  const [i, setI] = useState(0);
  const [note, setNote] = useState("");
  const canDecide = !f.res && (f.clinical ? role === "clinician" && w.state === "clinician" : role === "po" && (w.state === "po_draft" || w.state === "po_revise"));
  const needs = !!f.opts[i]?.needsNote;
  return (
    <div id={"flag-" + f.id} className={"issue fcard " + (f.res ? "done" : f.clinical ? "blocking" : "warning")}>
      <div className="ih">
        <span className="sev">{f.res ? "Decided" : f.clinical ? "With clinician" : f.kind}</span>
        {pos ? <span className="note">{pos}</span> : null}
        {onSelect ? <button type="button" className="lnk" onClick={() => onSelect(f.about)}>{itemLabel(f.about)}</button> : null}
      </div>
      <b>{f.title}</b>
      <div className="quote">{f.src}</div>
      {f.suggested && !f.clinical && !f.res ? <div className="note">The draft suggests asking the clinician. You decide whether to send it.</div> : null}
      {f.poNote ? <div className="note">{"Program officer: “" + f.poNote + "”"}</div> : null}
      {f.res ? (
        <div className="dec">{f.res.choice}{f.res.note ? " · “" + f.res.note + "”" : ""}{" · " + f.res.by + (f.res.round ? ", round " + f.res.round : ", before round 1")}</div>
      ) : canDecide ? (
        <div className="dform">
          <div className="chips">
            {f.opts.map((o, k) => <button key={k} type="button" className={"chipb" + (i === k ? " on" : "")} aria-pressed={i === k} onClick={() => setI(k)}>{o.label}</button>)}
          </div>
          <label className="sr" htmlFor={f.id + "-n"}>Note</label>
          <input id={f.id + "-n"} type="text" placeholder={needs ? "Note (required)" : "Note (optional)"} value={note} onChange={e => setNote(e.target.value)} />
          <button type="button" className="btn tiny primary" disabled={needs && !note.trim()} onClick={() => { onFlag(f.id, i, note.trim()); setNote(""); setI(0); }}>
            {f.opts[i]?.escalate ? "Send to clinician" : f.opts[i]?.fb ? "Request change" : "Record decision"}
          </button>
        </div>
      ) : (
        <div className="note">{f.clinical ? "Waiting for the clinician." : "Waiting for the program officer."}</div>
      )}
    </div>
  );
}

/** Flags as a deck of cards, one at a time, in a fixed order. Deciding one moves to the next open flag; selecting a step jumps to its flag. */
export function FlagsPanel({ w, role, onFlag, onSelect, sel }: { w: Workflow; role: Role; onFlag: OnFlag; onSelect: (id: string) => void; sel: string }) {
  const list = flagsFor(w, role);
  const [k, setK] = useState(() => Math.max(0, list.findIndex(f => !f.res)));
  const [lastSel, setLastSel] = useState(sel);
  if (sel !== lastSel) { setLastSel(sel); const j = list.findIndex(f => f.about === sel && !f.res); if (j >= 0) setK(j); }
  if (!list.length) return null;
  const at = Math.min(k, list.length - 1), f = list[at], open = list.filter(x => !x.res).length;
  return (
    <section className="panel">
      <div className="ph">
        <h2>Flags</h2>
        <span className="deck">
          <span className="ver">{open} open</span>
          <button type="button" className="btn tiny" aria-label="Previous flag" disabled={at === 0} onClick={() => setK(at - 1)}>{"◀"}</button>
          <span className="note">{(at + 1) + " of " + list.length}</span>
          <button type="button" className="btn tiny" aria-label="Next flag" disabled={at === list.length - 1} onClick={() => setK(at + 1)}>{"▶"}</button>
        </span>
      </div>
      <FlagCard key={f.id + (f.res ? ":done" : "") + (f.clinical ? ":c" : "")} f={f} w={w} role={role} onSelect={onSelect}
        onFlag={(id, c, n) => {
          onFlag(id, c, n);
          const order = [...list.keys()].map(j => (at + 1 + j) % list.length);
          const nx = order.find(j => j !== at && !list[j].res);
          if (nx !== undefined) setK(nx);
        }} />
    </section>
  );
}

/** Flags about one step, shown with that step. */
export function StepFlags({ w, role, id, onFlag }: { w: Workflow; role: Role; id: string; onFlag: OnFlag }) {
  const fs = flagsFor(w, role).filter(f => f.about === id);
  if (!fs.length) return null;
  return (
    <div className="stepflags">
      <div className="lab">{fs.length === 1 ? "Flag on this step" : fs.length + " flags on this step"}</div>
      {fs.map((f, j) => <FlagCard key={f.id + (f.res ? ":done" : "") + (f.clinical ? ":c" : "")} f={f} w={w} role={role} onFlag={onFlag} pos={fs.length > 1 ? (j + 1) + " of " + fs.length : undefined} />)}
    </div>
  );
}

export function ChecksPanel({ checks, m, onSelect }: { checks: Check[]; m: Model; onSelect: (id: string) => void }) {
  const g = golden(m), ok = g.filter(x => x.ok).length;
  const p = grid(m).length;
  const blocking = checks.filter(c => c.sev === "blocking").length;
  return (
    <section className="panel">
      <h2>Automatic checks</h2>
      <div className="kv"><span>Golden cases</span><b className={ok === g.length ? "okc" : "badc"}>{ok} / {g.length} match</b></div>
      <div className="kv"><span>Boundary patients run</span><b>{p}</b></div>
      <div className="kv"><span>Blocking problems</span><b className={blocking ? "badc" : "okc"}>{blocking}</b></div>
      {checks.length ? (
        <ul className="clist">
          {checks.map((c, i) => (
            <li key={i} className={c.sev}>
              <span className="sev">{c.sev[0].toUpperCase() + c.sev.slice(1)}</span>{" "}
              <button type="button" className="lnk" onClick={() => onSelect(c.id)}>{itemLabel(c.id)}</button>: {c.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function VersionsPanel({ w }: { w: Workflow }) {
  return (
    <section className="panel">
      <h2>Version history</h2>
      <div className="vrow"><span className="mono b">v3</span><span><b>Deployed</b><span className="note">{V3_HASH} · Oct 12</span></span></div>
      {w.versions.map((v, i) => (
        <div key={i} className="vrow"><span className="mono b">{v.ver}</span><span><b>{v.event}</b><span className="note">{v.meta}</span></span></div>
      ))}
      <p className="note" style={{ margin: 0 }}>Each version is a frozen logic model with a hash. An approval points at one hash.</p>
    </section>
  );
}
