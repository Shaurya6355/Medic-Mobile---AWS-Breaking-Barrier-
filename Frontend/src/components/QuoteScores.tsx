import { splitItem } from "../../../shared/pathway/index.ts";
import { getD, getO, getQ, itemLabel } from "../domain/logic";
import { fmtScore, type ItemScore } from "../domain/scores";
import type { ItemId, Model, QuoteScores } from "../domain/types";

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

/** The selected item's quote support, on the right side of the review screen (next to the question card).
    Shows the score even when it is high, because the clinician picked this item to look at; the caveat says what
    the number is not. It never feeds the checks, the blocking count or the approve button. */
export function ItemQuoteCard({ s, m, idx, id }: { s: QuoteScores | null | undefined; m: Model; idx: Map<ItemId, ItemScore>; id: string }) {
  if (!s || !id) return null;
  const v = idx.get(id);
  // "scope" is the default selection, not a pick: say nothing about it unless it was actually scored.
  if (id === "scope" && !v) return null;
  const body = s.status === "failed" ? <p className="note">Quote scoring did not finish for this run. Nothing else is affected.</p>
    : s.status !== "scored" ? <p className="note">{"No quote scores for version " + s.n + ". Only the AI draft (version 1) is scored today."}</p>
    : v ? <Detail v={v} m={m} />
    : <p className="note"><b>{label(m, id)}</b>{": not scored. It cites no guideline quote, or it was added after scoring."}</p>;
  return (
    <section className="qs-card" aria-label="Quote support">
      <div className="qs-chead">
        <span className="qs-lab">{"Quote support" + (s.status === "scored" ? (s.sample ? " · sample scores" : " · scored on version " + s.n) : "")}</span>
      </div>
      {body}
      <p className="note qs-caveat">Advisory: whether the quote backs the item, not whether the item is clinically right. It never blocks approval.</p>
    </section>
  );
}

/** One line on the question card when the item it asks about has a weak quote. Nothing for a good score, so a
    high number never sits next to "Keep it". */
export function QuestionScoreNote({ v }: { v: ItemScore | undefined }) {
  if (!v || !v.flagged) return null;
  if (v.stale) return <p className="qs-qnote old">Its quote was scored on the earlier text, before your edit.</p>;
  const e = v.entry;
  return (
    <p className="qs-qnote">
      <b>{"The cited quote may not support this (" + fmtScore(e.score) + ")"}</b>
      {e.lowest_reason ? ": " + e.lowest_reason : e.why ? ": " + e.why : "."}
    </p>
  );
}
