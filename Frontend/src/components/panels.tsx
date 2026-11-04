import { useState } from "react";
import { V3_HASH } from "../domain/data";
import { golden } from "../domain/logic";
import type { Check, Flag, Model, Role, Workflow } from "../domain/types";

export function FlagsPanel({ w, role, onFlag, onSelect }: { w: Workflow; role: Role; onFlag: (id: string, choice: number, note: string) => void; onSelect: (id: string) => void }) {
  return (
    <section className="panel">
      <div className="ph"><h2>Flags</h2><span className="ver">{w.flags.filter(f => !f.res).length} open</span></div>
      {w.flags.map(f => <FlagItem key={f.id} f={f} w={w} role={role} onFlag={onFlag} onSelect={onSelect} />)}
    </section>
  );
}

function FlagItem({ f, w, role, onFlag, onSelect }: { f: Flag; w: Workflow; role: Role; onFlag: (id: string, choice: number, note: string) => void; onSelect: (id: string) => void }) {
  const [i, setI] = useState(0);
  const [note, setNote] = useState("");
  const canDecide = !f.res && (f.clinical ? role === "clinician" && w.state === "clinician" : role === "po" && (w.state === "po_draft" || w.state === "po_revise"));
  return (
    <div id={"flag-" + f.id} className={"issue " + (f.res ? "done" : f.clinical ? "blocking" : "warning")}>
      <div className="ih">
        <span className="sev">{f.res ? "Decided" : f.kind}</span>
        <b>{f.title}</b>
        <button type="button" className="lnk" onClick={() => onSelect(f.about)}>{f.about}</button>
      </div>
      <div className="quote">{f.src}</div>
      <div className="note">{f.why}</div>
      {f.res ? (
        <div className="dec">{f.res.choice}{f.res.note ? " · “" + f.res.note + "”" : ""}{" · " + f.res.by + (f.res.round ? ", round " + f.res.round : ", before round 1")}</div>
      ) : canDecide ? (
        <div className="dform">
          <div className="chips">
            {f.opts.map((o, k) => <button key={k} type="button" className={"chipb" + (i === k ? " on" : "")} aria-pressed={i === k} onClick={() => setI(k)}>{o.label}</button>)}
          </div>
          <label className="sr" htmlFor={f.id + "-n"}>Note</label>
          <input id={f.id + "-n"} type="text" placeholder="Note (required)" value={note} onChange={e => setNote(e.target.value)} />
          <button type="button" className="btn tiny" disabled={!note.trim()} onClick={() => onFlag(f.id, i, note.trim())}>Record decision</button>
        </div>
      ) : (
        <div className="note">{f.clinical ? "The clinician decides this." + (f.escalated ? " Escalated by the program officer." : "") : "The program officer decides this."}</div>
      )}
    </div>
  );
}

export function ChecksPanel({ checks, m, onSelect }: { checks: Check[]; m: Model; onSelect: (id: string) => void }) {
  const g = golden(m), ok = g.filter(x => x.ok).length;
  const blocking = checks.filter(c => c.sev === "blocking").length;
  return (
    <section className="panel">
      <h2>Automatic checks</h2>
      <div className="kv"><span>Golden cases</span><b className={ok === g.length ? "okc" : "badc"}>{ok} / {g.length} match</b></div>
      <div className="kv"><span>Blocking problems</span><b className={blocking ? "badc" : "okc"}>{blocking}</b></div>
      {checks.length ? (
        <ul className="clist">
          {checks.map((c, i) => (
            <li key={i} className={c.sev}>
              <span className="sev">{c.sev[0].toUpperCase() + c.sev.slice(1)}</span>{" "}
              <button type="button" className="lnk" onClick={() => onSelect(c.id)}>{c.id}</button>: {c.text}
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
