/* Compiler preview: logic model to XLSForm survey rows. Deterministic, no AI. */
import { OUTCODE } from "./data";
import { questionOrder } from "./logic";
import type { Model } from "./types";

export type XlsRow = [type: string, name: string, label: string, relevant: string, calc: string];

const ref = (x: string) => "${" + x + "}";
function condX(m: Model, id: "d2" | "d3"): string {
  const parts = m[id].conds.map(c => (c === "ci" ? ref("chest_indrawing") : c === "stridor" ? ref("stridor") : ref("fast_breathing")) + " = 'yes'");
  return parts.length ? parts.join(" or ") : "false()";
}
function dangerX(m: Model): string {
  const d = ref("danger_signs");
  if (m.d1.signs.length === 4) return "if(count-selected(" + d + ") > 0 and not(selected(" + d + ", 'none')), 'yes', 'no')";
  return "if(" + (m.d1.signs.map(s => "selected(" + d + ", '" + s + "')").join(" or ") || "false()") + ", 'yes', 'no')";
}
const classX = (m: Model) => "if(" + ref("danger_any") + " = 'yes', 'severe_pneumonia', if(" + condX(m, "d2") + ", 'severe_pneumonia', if(" + condX(m, "d3") + ", 'pneumonia', 'no_pneumonia')))";
const relX = (s: string) => (s ? s.replace(/(\w+)\s*=\s*(\w+)/g, (_a, f, v) => ref(f) + " = '" + v + "'").replace(/\bAND\b/gi, "and") : "");

export function xlsRows(m: Model): XlsRow[] {
  const rows: XlsRow[] = [["begin group", "inputs", "Inputs", "", ""], ["string", "source", "", "", "(CHT contact inputs)"], ["end group", "", "", "", ""]];
  questionOrder(m).forEach(q => {
    const x = m.questions[q]; if (!x) return;
    const t = x.type === "yesno" ? "select_one yes_no" : x.type === "int" ? "integer" : "select_multiple danger";
    const con = q === "age_months" ? ". >= " + m.start.ageMin + " and . < " + m.start.ageMax : q === "resp_rate" ? ". >= 0 and . <= 150" : "";
    rows.push([t, q, x.label, relX(x.showIf), con]);
  });
  rows.push(["calculate", "danger_any", "", "", dangerX(m)]);
  rows.push(["calculate", "fast_breathing", "", "", "if(" + ref("age_months") + " < " + m.d3.cut + ", if(" + ref("resp_rate") + " >= " + m.d3.young + ", 'yes', 'no'), if(" + ref("resp_rate") + " >= " + m.d3.old + ", 'yes', 'no'))"]);
  rows.push(["calculate", "classification", "", "", classX(m)]);
  rows.push(["calculate", "follow_up_date", "", ref("classification") + " = 'pneumonia'", "format-date-time(decimal-date-time(today()) + " + m.f1.due + ", '%Y-%m-%d')"]);
  (["o1", "o2", "o3"] as const).forEach(o => rows.push(["note", "n_" + OUTCODE[o], m[o].title.toUpperCase() + ". " + m[o].note, ref("classification") + " = '" + OUTCODE[o] + "'", ""]));
  return rows;
}

export interface RowDiff { k: "same" | "add" | "del"; r: XlsRow }
export function rowDiff(a: XlsRow[], b: XlsRow[]): RowDiff[] {
  const keyOf = (r: XlsRow, i: number) => (r[1] || r[0]) + "#" + (r[1] ? "" : i);
  const index = (rs: XlsRow[]) => { const o: Record<string, XlsRow> = {}; rs.forEach((r, i) => { o[keyOf(r, i)] = r; }); return o; };
  const A = index(a), B = index(b), out: RowDiff[] = [];
  const keys = b.map(keyOf);
  a.forEach((r, i) => { const k = keyOf(r, i); if (!keys.includes(k)) keys.splice(Math.min(i, keys.length), 0, k); });
  keys.forEach(k => {
    if (A[k] && B[k]) {
      if (JSON.stringify(A[k]) === JSON.stringify(B[k])) out.push({ k: "same", r: B[k] });
      else { out.push({ k: "del", r: A[k] }); out.push({ k: "add", r: B[k] }); }
    } else if (A[k]) out.push({ k: "del", r: A[k] });
    else out.push({ k: "add", r: B[k] });
  });
  return out;
}
