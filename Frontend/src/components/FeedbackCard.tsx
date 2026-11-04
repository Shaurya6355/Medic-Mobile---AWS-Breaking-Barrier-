import { useState } from "react";
import { CondSyntaxError, parse } from "../../../shared/pathway/index.ts";
import { fbLabel } from "../domain/data";
import { suggestionCheckText } from "../domain/workflow";
import type { Patch, Suggestion, SuggestionOutcome, Workflow } from "../domain/types";

type OnSug = (id: string, o: SuggestionOutcome, patch?: Patch) => void;
type Target = NonNullable<Extract<Suggestion, { kind: "clarify" }>["target"]>;

/** The PO types the change the clinician asked for; Accept applies it. Used when the AI could not read an exact value. */
function TypeChange({ id, t, onSug }: { id: string; t: Target; onSug: OnSug }) {
  const [v, setV] = useState(t.value === "(none)" ? "" : t.value);
  let patch: Patch | null = null, err = "";
  const s = v.trim();
  try {
    if (t.kind === "cond") patch = s ? { op: "set", path: t.path, value: parse(s) } : { op: "unset", path: t.path };
    else if (t.kind === "number") patch = s && !isNaN(Number(s)) ? { op: "set", path: t.path, value: Number(s) } : null;
    else if (t.kind === "numberOrNull") patch = !s ? { op: "set", path: t.path, value: null } : !isNaN(Number(s)) ? { op: "set", path: t.path, value: Number(s) } : null;
    else if (t.kind === "source") patch = s ? { op: "set", path: t.path, value: { page: t.page ?? 1, quote: s } } : null;
    else patch = s ? { op: "set", path: t.path, value: s } : null;
  } catch (e) { err = e instanceof CondSyntaxError ? e.message : String(e); }
  const fid = "tc-" + id;
  return (
    <div className="dform">
      <label className="lab" htmlFor={fid}>{t.label}</label>
      <input id={fid} type={t.kind.startsWith("number") ? "number" : "text"} className={t.kind === "cond" ? "mono" : undefined} value={v} onChange={e => setV(e.target.value)} />
      {err ? <div className="note badc">{err}</div> : null}
      <div className="btnrow">
        <button type="button" className="btn tiny ok" disabled={!patch} onClick={() => patch && onSug(id, "accepted", patch)}>Accept this change</button>
        <button type="button" className="btn tiny" onClick={() => onSug(id, "discarded")}>Edit the step myself</button>
      </div>
    </div>
  );
}

/** Shown to the PO in po_revise: the clinician's feedback plus the AI suggestion. Nothing applies until accepted. */
export function FeedbackCard({ w, id, onSug }: { w: Workflow; id: string; onSug: OnSug }) {
  const r = w.reviews[id];
  if (!r || r.status !== "changes" || r.round !== w.round) return null;
  const s = w.sug[id];
  return (
    <div className="fbcard">
      <div><b>{"Clinician feedback, round " + r.round + " · " + fbLabel(r.type) + ": "}</b>{r.note}{r.value ? " (new value: " + r.value + ")" : ""}</div>
      {s ? (
        <div className="sug">
          <div className="sugh">
            <span className="badge ai2">Suggested revision</span>
            <span className="note">Built only from this feedback · not applied until you accept</span>
          </div>
          {s.outcome ? (
            <div className="dec">
              {s.outcome === "accepted" ? "Accepted" : s.outcome === "edited" ? "Applied; edited by you" : w.fixed[id] ? "Discarded; you edited it yourself" : "Discarded. Edit the step yourself to resolve it."}
            </div>
          ) : s.kind === "change" ? (
            <>
              <div><span className="note">{s.field + ": "}</span><del>{s.from}</del>{" → "}<b className="ins2">{s.to}</b></div>
              <div className="note okc">{suggestionCheckText(w.model, s)}</div>
              <div className="btnrow">
                <button type="button" className="btn tiny ok" onClick={() => onSug(id, "accepted")}>Accept suggestion</button>
                <button type="button" className="btn tiny" onClick={() => onSug(id, "edited")}>Accept, then edit</button>
                <button type="button" className="btn tiny bad" onClick={() => onSug(id, "discarded")}>Discard</button>
              </div>
            </>
          ) : (
            <>
              <div className="note">{s.text}</div>
              {s.target ? <TypeChange id={id} t={s.target} onSug={onSug} /> : <button type="button" className="btn tiny" onClick={() => onSug(id, "discarded")}>Edit the step myself</button>}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
