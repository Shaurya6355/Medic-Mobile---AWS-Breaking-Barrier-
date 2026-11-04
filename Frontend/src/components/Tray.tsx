import { anyQ, qStatus, trayIds } from "../domain/logic";
import type { Model } from "../domain/types";
import type { Markers } from "./Flow";

/** Questions that no rule uses, and questions removed relative to v3. */
export function Tray({ m, selected, onSelect, markers = {} }: { m: Model; selected: string; onSelect: (id: string) => void; markers?: Markers }) {
  const ids = trayIds(m);
  if (!ids.length) return null;
  return (
    <div className="tray">
      <div className="tray-h">Questions not used by any rule</div>
      <div className="tray-items">
        {ids.map(q => {
          const st = qStatus(m, q), id = "q:" + q, x = m.questions[q] || anyQ(q);
          return (
            <button key={q} type="button" className={"titem" + (selected === id ? " sel" : "") + (st === "removed" ? " gone" : "")} onClick={() => onSelect(id)}>
              <span className="badges">
                <span className={"badge q-" + st}>{st === "same" ? "Unused" : st[0].toUpperCase() + st.slice(1)}</span>
                {(markers[id] || []).map((b, i) => <span key={i} className={"badge " + b[0]}>{b[1]}</span>)}
              </span>
              <span className="mono">{q}</span>
              <span>{x?.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
