import { useEffect, useState } from "react";
import * as api from "../api";
import type { AuditRow, Workflow } from "../domain/types";
import type { Actions } from "../actions";
import { VersionsPanel } from "../components/panels";

/** History = audit log + version history. */
export function HistoryScreen({ w, act }: { w: Workflow | null; act: Actions }) {
  const [audit, setAudit] = useState<AuditRow[]>([]);
  useEffect(() => {
    if (!w) { setAudit([]); return; }
    api.getAudit(w.id).then(setAudit);
  }, [w]);

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <section className="panel">
        <div className="ph"><h2>Audit log</h2><span className="ver">Append-only · {audit.length} events</span></div>
        {audit.length ? (
          <div className="tw">
            <table>
              <thead><tr>{["Time", "Event", "By", "Version", "Hash", "Note"].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
              <tbody>
                {audit.slice().reverse().map((a, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{a.t}</td><td>{a.event}</td><td>{a.actor}</td>
                    <td className="mono">{a.ver}</td><td className="mono">{a.hash}</td><td>{a.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="note">No events yet.</p>}
      </section>
      {w ? <VersionsPanel w={w} /> : null}
      <div><button type="button" className="btn" onClick={act.reset}>Reset demo</button></div>
    </div>
  );
}
