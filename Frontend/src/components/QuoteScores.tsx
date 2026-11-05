import { splitItem } from "../../../shared/pathway/index.ts";
import { getD, getO, getQ, itemLabel } from "../domain/logic";
import { fmtScore, readFirst, type ItemScore } from "../domain/scores";
import type { ItemId, Model, QuoteScores } from "../domain/types";
import { SectionHead } from "./Page";

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const KIND: Record<string, string> = { scope: "Applies to", question: "Question", derived: "Derived value", rule: "Rule", outcome: "Classification", action: "Action", follow_up: "Follow-up task" };
const pct = (x: number | null | undefined) => Math.max(0, Math.min(100, Math.round((x ?? 0) * 100)));

/** The item in the model's own words: "Question: Is the child unusually sleepy…", "Rule R5". */
function label(m: Model, id: ItemId): string {
  const [k, key] = splitItem(id);
  const t = k === "q" ? getQ(m, key)?.label : k === "d" ? getD(m, key)?.label : k === "out" ? getO(m, key)?.title : k === "fu" ? "Follow-up: " + (getO(m, key)?.title ?? key) : undefined;
  const kind = k === "q" ? "Question" : k === "d" ? "Derived" : k === "out" ? "Classification" : "";
  return t ? (kind ? kind + ": " : "") + t : itemLabel(id);
}

/** Score against the 0.70 flag line. */
function Bar({ score }: { score: number | null | undefined }) {
  return <span className="qs-bar" aria-hidden="true"><i style={{ width: pct(score) + "%" }} /><b /></span>;
}

/** Details for one item: score, why it was flagged, the judge's weakest reason, the quote and its pages. */
function Detail({ v, m }: { v: ItemScore; m: Model }) {
  const e = v.entry;
  const pages = [...new Set(v.entries.flatMap(x => x.pages ?? []))];
  const quotes = [...new Set(v.entries.flatMap(x => x.quotes ?? []))];
  return (
    <div className={"qs-detail" + (v.stale ? " old" : "")}>
      <div className="qs-dhead">
        <b>{label(m, v.id)}</b>
        <span className={"badge qs" + (v.stale ? " old" : "") + (v.flagged ? "" : " fine")}>{v.flagged ? "Flagged" : "Looks supported"}</span>
      </div>
      {v.stale ? <p className="note qs-stale">Edited since it was scored. This score describes the AI draft, not the current text.</p> : null}
      <div className="qs-score">
        <span className="qs-num">{fmtScore(e.score)}</span>
        <Bar score={e.score} />
        <span className="note">flag line 0.70</span>
      </div>
      <dl className="qs-dl">
        {e.why ? <><dt>Why flagged</dt><dd>{cap(e.why)}</dd></> : null}
        {e.agreement !== undefined && e.agreement !== null ? <><dt>Agreement</dt><dd>{fmtScore(e.agreement)}</dd></> : null}
        {e.lowest_reason ? <><dt>Lowest sample</dt><dd>{e.lowest_reason}</dd></> : null}
        {v.entries.length > 1 ? <><dt>Parts scored</dt><dd>{v.entries.map(x => (KIND[x.kind] ?? x.kind) + " " + fmtScore(x.score)).join(" · ")}</dd></> : null}
      </dl>
      {quotes.length ? (
        <div className="qs-quote">
          <span className="qs-lab">{"Quote scored" + (pages.length ? " · page " + pages.join(", ") : "")}</span>
          {quotes.map((q, i) => <blockquote key={i}>{q}</blockquote>)}
        </div>
      ) : null}
    </div>
  );
}

/** The quote check in the View tab: the advisory notice, the flagged items to read first, and the selected item's
    details. It never feeds the checks, the blocking count or the approve button. */
export function QuoteScoresPanel({ s, m, idx, sel, onSelect }: { s: QuoteScores | null | undefined; m: Model; idx: Map<ItemId, ItemScore>; sel: string; onSelect: (id: ItemId) => void }) {
  if (!s) return null;
  const sub = "Advisory: a model's opinion of how well each quote supports its item. It never blocks approval.";
  if (s.status !== "scored") {
    return (
      <section className="qs" aria-label="Quote check">
        <SectionHead icon="format_quote" tone="grey" title="Quote check" sub={sub} />
        <p className="note">{s.status === "failed"
          ? "Quote scoring did not finish for this run. Review the quotes as usual; nothing else is affected."
          : "No quote scores for version " + s.n + ". Only the AI draft (version 1) is scored today."}</p>
      </section>
    );
  }
  const first = readFirst(idx);
  const stale = [...idx.values()].filter(v => v.flagged && v.stale).length;
  const picked = idx.get(sel);
  return (
    <section className="qs" aria-label="Quote check">
      <SectionHead icon="format_quote" tone="grey" title="Quote check" sub="Which guideline quotes to read first."
        aside={<span className="badge qs">{s.sample ? "Sample scores" : "Scored on version " + s.n}</span>} />
      <p className="qs-notice">{s.notice}</p>
      <div className="qs-chips">
        <span className="qs-chip flag">{s.summary.flagged + " flagged"}</span>
        <span className="qs-chip">{s.summary.scored - s.summary.flagged + " look supported"}</span>
        {s.summary.not_scored ? <span className="qs-chip">{s.summary.not_scored + " cite no quote"}</span> : null}
        {stale ? <span className="qs-chip">{stale + " edited since scoring"}</span> : null}
      </div>
      {first.length ? (
        <>
          <h3 className="qs-sub">Read these quotes first</h3>
          <ul className="qs-list">
            {first.map(v => (
              <li key={v.id}>
                <button type="button" className={"qs-item" + (sel === v.id ? " on" : "")} aria-pressed={sel === v.id} onClick={() => onSelect(v.id)}>
                  <span className="qs-row"><b>{label(m, v.id)}</b><span className="qs-val">{fmtScore(v.entry.score)}</span></span>
                  <Bar score={v.entry.score} />
                  {v.entry.why ? <span className="note">{cap(v.entry.why)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="note">No quote is flagged{stale ? " that still matches the current text" : ""}.</p>}
      {picked ? <Detail v={picked} m={m} /> : <p className="note">Select a box in the flow, or an item above, to see its quote score.</p>}
    </section>
  );
}
