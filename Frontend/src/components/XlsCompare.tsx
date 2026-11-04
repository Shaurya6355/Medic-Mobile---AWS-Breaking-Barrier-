import { rowDiff, xlsRows } from "../domain/xls";
import type { Model } from "../domain/types";

/** XLSForm survey rows, old vs new. Generated from the model by the deterministic compiler. */
export function XlsCompare({ a, b, la, lb }: { a: Model; b: Model; la: string; lb: string }) {
  const rows = rowDiff(xlsRows(a), xlsRows(b));
  const n = rows.filter(r => r.k === "add").length;
  return (
    <section className="panel">
      <div className="ph">
        <h2>{"survey sheet · " + la + " → " + lb}</h2>
        <span className="ver">{n + " row" + (n === 1 ? "" : "s") + " added or changed"}</span>
      </div>
      <div className="tw">
        <table className="xls">
          <thead><tr>{["", "type", "name", "label", "relevant", "calculate / constraint"].map((t, i) => <th key={i}>{t}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.k}>
                <td className="m">{r.k === "del" ? "−" : r.k === "add" ? "+" : ""}</td>
                {r.r.map((c, j) => <td key={j}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
