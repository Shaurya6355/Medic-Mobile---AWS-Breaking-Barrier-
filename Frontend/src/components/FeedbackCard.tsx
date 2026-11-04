import { fbLabel } from "../domain/data";
import { suggestionCheckText } from "../domain/workflow";
import type { SuggestionOutcome, Workflow } from "../domain/types";

/** Shown to the PO in po_revise: the clinician's feedback plus the AI suggestion. Nothing applies until accepted. */
export function FeedbackCard({ w, id, onSug }: { w: Workflow; id: string; onSug: (id: string, o: SuggestionOutcome) => void }) {
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
            <span className="note">Bedrock · built only from this feedback · not applied until you accept</span>
          </div>
          {s.outcome ? (
            <div className="dec">
              {s.outcome === "accepted" ? "Accepted" : s.outcome === "edited" ? "Applied; edited by you" : w.fixed[id] ? "Discarded; you edited it yourself" : "Discarded. Edit the box yourself to resolve it."}
            </div>
          ) : s.kind === "change" ? (
            <>
              <div><span className="note">{s.field + ": "}</span><del>{s.from}</del>{" → "}<b className="ins2">{s.to}</b></div>
              <div className="note okc">{suggestionCheckText(w.model, s)}</div>
              <div className="btnrow">
                <button type="button" className="btn tiny ok" onClick={() => onSug(id, "accepted")}>Accept</button>
                <button type="button" className="btn tiny" onClick={() => onSug(id, "edited")}>Edit before accepting</button>
                <button type="button" className="btn tiny bad" onClick={() => onSug(id, "discarded")}>Discard</button>
              </div>
            </>
          ) : (
            <>
              <div className="banner">{s.text}</div>
              <button type="button" className="btn tiny" onClick={() => onSug(id, "discarded")}>Edit it myself</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
