import { useState } from "react";
import { FB_TYPES, fbLabel } from "../domain/data";
import type { Decision, FbType, Review } from "../domain/types";
import { Field } from "./inputs";

/** Clinician controls for one box: approve, or request a structured change. */
export function ReviewControls({ id, review, required, onDecide }: { id: string; review: Review | null; required: boolean; onDecide: (d: Decision | null) => void }) {
  const [type, setType] = useState<FbType | "">("");
  const [note, setNote] = useState("");
  const [val, setVal] = useState("");

  if (review) return (
    <div className={"rv " + review.status}>
      <b>{review.status === "approved" ? "You approved this step" : "Change requested · " + fbLabel(review.type)}</b>
      {review.status === "changes" ? <div>{review.note}{review.value ? <span className="note">{" · new value: " + review.value}</span> : null}</div> : null}
      <button type="button" className="btn tiny" onClick={() => onDecide(null)}>Change my decision</button>
    </div>
  );

  return (
    <div className="rv">
      <div className="note">{required ? "This step changed. Approve it, or request a change. The program officer applies changes." : "This step is unchanged from v3. You can still request a change."}</div>
      <button type="button" className="btn ok" onClick={() => onDecide({ status: "approved" })}>Approve this step</button>
      <div className="lab">Or request a change: what is wrong?</div>
      <div className="chips" role="radiogroup" aria-label="What is wrong">
        {FB_TYPES.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={type === k} className={"chipb" + (type === k ? " on" : "")} onClick={() => setType(k)}>{l}</button>
        ))}
      </div>
      <Field id={"fb-note-" + id} label="Say exactly what to change (required)">
        <input id={"fb-note-" + id} type="text" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
      <Field id={"fb-val-" + id} label="New value (optional)">
        <input id={"fb-val-" + id} type="text" value={val} onChange={e => setVal(e.target.value)} />
      </Field>
      <button type="button" className="btn bad" disabled={!type || !note.trim()}
        onClick={() => type && onDecide({ status: "changes", type, note: note.trim(), value: val.trim() })}>Request change</button>
    </div>
  );
}
