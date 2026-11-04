import { item } from "../../../shared/pathway/index.ts";
import { DRAFT, V3 } from "../domain/data";
import { anyQ, getQ, qStatus, trayIds } from "../domain/logic";
import type { Model } from "../domain/types";
import type { Markers } from "./Flow";

/** Below the flow: the derived values the rules read, and every form question (unused and removed ones marked). */
export function Tray({ m, selected, onSelect, markers = {} }: { m: Model; selected: string; onSelect: (id: string) => void; markers?: Markers }) {
  const unused = new Set(trayIds(m));
  const qids = [...new Set([...m.questions.slice().sort((a, b) => a.order - b.order).map(q => q.id), ...[...V3.questions, ...DRAFT.questions].map(q => q.id)])];
  const badgesOf = (id: string) => (markers[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>);
  return (
    <>
      {m.derived.length ? (
        <div className="tray">
          <div className="tray-h">Derived values (computed from answers, read by the rules)</div>
          <div className="tray-items">
            {m.derived.map(d => {
              const id = item.d(d.id);
              return (
                <button key={id} type="button" className={"titem" + (selected === id ? " sel" : "")} onClick={() => onSelect(id)}>
                  <span className="badges">{badgesOf(id)}</span>
                  <span className="mono">{d.id}</span>
                  <span>{d.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="tray">
        <div className="tray-h">Form questions</div>
        <div className="tray-items">
          {qids.map(q => {
            const st = qStatus(m, q), id = item.q(q), x = getQ(m, q) || anyQ(q);
            const tag = st === "removed" ? "Removed" : unused.has(q) ? "Unused" : st === "same" ? null : st[0].toUpperCase() + st.slice(1);
            return (
              <button key={q} type="button" className={"titem" + (selected === id ? " sel" : "") + (st === "removed" ? " gone" : "")} onClick={() => onSelect(id)}>
                <span className="badges">{tag ? <span className={"badge q-" + (st === "same" ? "same" : st)}>{tag}</span> : null}{badgesOf(id)}</span>
                <span className="mono">{q}</span>
                <span>{x?.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
