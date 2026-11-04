import { useEffect } from "react";
import { itemLabel } from "../domain/logic";
import { stageName, type Stage, type StageStatus } from "../domain/checks";
import type { Check, CheckKey } from "../domain/types";

const LABEL: Record<StageStatus, string> = { pass: "Passed", warn: "Warnings", fail: "Failed", skipped: "Not run", missing: "Needs input" };

/** Go to a check even when the address already points at it (a plain link would not fire hashchange then). */
function goCheck(e: React.MouseEvent, k: CheckKey) {
  e.preventDefault();
  history.pushState(null, "", "#check-" + k);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** A link to one check: opens the Checks tab with that check expanded. Shareable: /review#check-quote. */
export function CheckLink({ k }: { k?: CheckKey }) {
  if (!k) return null;
  return <a className="chklink" href={"#check-" + k} onClick={e => goCheck(e, k)}>{stageName(k)}</a>;
}

/** One issue: which check found it, the step it is on, and what is wrong. */
export function IssueLine({ c, onSelect, showCheck = true }: { c: Check; onSelect?: (id: string) => void; showCheck?: boolean }) {
  return (
    <li className={c.sev}>
      <span className="sev">{c.sev === "blocking" ? "Fix" : "Check"}</span>{" "}
      <span>
        {showCheck && c.kind ? <><CheckLink k={c.kind} />{" · "}</> : null}
        {onSelect ? <><button type="button" className="lnk" onClick={() => onSelect(c.id)}>{itemLabel(c.id)}</button>{": "}</> : null}
        {c.text}
      </span>
    </li>
  );
}

/** The check pipeline, in order, for every role. Each check is a link; opening it lists its errors, each linked to its step. */
export function CheckPipeline({ stages, open, setOpen, onSelect }: { stages: Stage[]; open: CheckKey | null; setOpen: (k: CheckKey | null) => void; onSelect: (id: string) => void }) {
  useEffect(() => { if (open) document.getElementById("check-" + open)?.scrollIntoView({ block: "nearest" }); }, [open]);
  const sec = (owner: Stage["owner"]) => stages.filter(s => s.owner === owner).map(s => {
    const on = open === s.key, n = s.issues.length;
    return (
      <div key={s.key} id={"check-" + s.key} className={"stage s-" + s.status + (on ? " on" : "")}>
        <a className="stage-h" href={"#check-" + s.key} aria-expanded={on}
          onClick={e => { if (on) { e.preventDefault(); setOpen(null); history.replaceState(null, "", location.pathname + location.search); } else goCheck(e, s.key); }}>
          <span className="sn">{s.n}</span>
          <span className="sname">{s.name}</span>
          <span className={"pill " + s.status}>{LABEL[s.status] + (n && (s.status === "fail" || s.status === "warn") ? " · " + n : "")}</span>
        </a>
        <div className="note">{s.summary}</div>
        {on ? (
          <div className="sbody">
            <div className="note"><b>Asks: </b>{s.asks}</div>
            {s.uses ? <div className="note"><b>Against: </b>{s.uses}</div> : null}
            {s.parts ? (
              <ul className="parts">
                {s.parts.map((p, i) => <li key={i} className={p.ok ? "ok" : "bad"}><span aria-hidden="true">{p.ok ? "✓" : "✗"}</span> <b>{p.name}</b> <span className="note">{p.text}</span></li>)}
              </ul>
            ) : null}
            {n ? <ul className="clist">{s.issues.map((c, i) => <IssueLine key={i} c={c} onSelect={onSelect} showCheck={false} />)}</ul>
              : s.status === "pass" ? <div className="note okc">No errors.</div> : null}
          </div>
        ) : null}
      </div>
    );
  });
  return (
    <div className="pipe">
      <div className="pipe-sec">Program officer fixes</div>
      {sec("po")}
      <div className="pipe-sec">Clinician</div>
      {sec("clinician")}
    </div>
  );
}
