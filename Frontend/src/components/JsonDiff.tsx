import { useMemo, useState } from "react";

type Line = { k: "same" | "add" | "del"; t: string; a?: number; b?: number };

/** Line diff (longest common subsequence). Logic models are a few hundred lines, so the table stays small. */
function diffLines(a: string[], b: string[]): Line[] {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Line[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ k: "same", t: a[i], a: ++i, b: ++j }); }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ k: "del", t: a[i], a: ++i });
    else out.push({ k: "add", t: b[j], b: ++j });
  }
  while (i < n) out.push({ k: "del", t: a[i], a: ++i });
  while (j < m) out.push({ k: "add", t: b[j], b: ++j });
  return out;
}

/** JSON diff of two logic models: changed lines with 3 lines of context, unchanged runs folded. */
export function JsonDiff({ a, b, la, lb }: { a: unknown; b: unknown; la: string; lb: string }) {
  const lines = useMemo(() => diffLines(JSON.stringify(a, null, 2).split("\n"), JSON.stringify(b, null, 2).split("\n")), [a, b]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const adds = lines.filter(l => l.k === "add").length, dels = lines.filter(l => l.k === "del").length;
  const near = new Set<number>();
  lines.forEach((l, i) => { if (l.k !== "same") for (let d = -3; d <= 3; d++) near.add(i + d); });
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!near.has(i) && !open[i]) {
      let j = i; while (j < lines.length && !near.has(j)) j++;
      const start = i;
      rows.push(<tr key={"f" + i} className="fold"><td colSpan={4}><button type="button" className="lnk" onClick={() => setOpen(o => { const x = { ...o }; for (let k = start; k < j; k++) x[k] = true; return x; })}>{"… " + (j - i) + " unchanged lines"}</button></td></tr>);
      i = j - 1; continue;
    }
    const l = lines[i];
    rows.push(<tr key={i} className={l.k}><td className="ln">{l.a ?? ""}</td><td className="ln">{l.b ?? ""}</td><td className="m">{l.k === "add" ? "+" : l.k === "del" ? "−" : ""}</td><td><pre>{l.t}</pre></td></tr>);
  }
  return (
    <div className="jdiff">
      <div className="note">{la + " → " + lb + " · "}<span className="okc">{"+" + adds}</span>{" "}<span className="badc">{"−" + dels}</span>{" lines"}</div>
      <div className="tw"><table><tbody>{rows}</tbody></table></div>
    </div>
  );
}
