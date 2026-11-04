/* Writes samples/cough-guideline-sample.pdf: a small synthetic guideline with a real text layer,
   for testing the pipeline. Synthetic test data, loosely based on the public WHO IMCI chart. Not clinical advice.
   Run: cd shared && npm run sample-pdf */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 12 pages, so every quote in shared/pathway/samples/cough_fast_breathing.v1.json sits on the page it cites. */
/* Page lines live in shared/pathway/samples so the review UI's sample mode can run the quote check on the same text.
   A line starting with # is a heading. */
const PAGES = JSON.parse(readFileSync(new URL("../pathway/samples/cough-guideline.pages.json", import.meta.url), "utf8")) as string[][];

const esc = (s: string) => s.replace(/[\\()]/g, m => "\\" + m);
function stream(lines: string[]): string {
  let y = 790;
  const ops = ["BT"];
  for (const raw of lines) {
    const heading = raw.startsWith("#");
    const text = heading ? raw.slice(1) : raw;
    ops.push(`/${heading ? "F2" : "F1"} ${heading ? 13 : 11} Tf 1 0 0 1 56 ${y} Tm (${esc(text)}) Tj`);
    y -= text ? (heading ? 22 : 17) : 10;
  }
  ops.push("ET");
  return ops.join("\n");
}

const objs: string[] = [];
const add = (s: string) => { objs.push(s); return objs.length; };
const catalog = add("");
const pages = add("");
const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
const kids: number[] = [];
for (const p of PAGES) {
  const s = stream(p);
  const content = add(`<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
}
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;

let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../Backend/samples/cough-guideline-sample.pdf");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, pdf, "latin1");
console.log("wrote " + out);
