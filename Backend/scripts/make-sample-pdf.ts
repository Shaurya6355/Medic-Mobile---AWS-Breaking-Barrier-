/* Writes samples/cough-guideline-sample.pdf: a small synthetic guideline with a real text layer,
   for testing the pipeline. Synthetic test data, loosely based on the public WHO IMCI chart. Not clinical advice.
   Run: npm run sample-pdf */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGES: string[][] = [
  [
    "#SAMPLE GUIDELINE - SYNTHETIC TEST DATA - NOT CLINICAL ADVICE",
    "",
    "#Assess and classify the sick child aged 2 months up to 5 years",
    "",
    "Check for general danger signs:",
    "- Not able to drink or breastfeed",
    "- Vomits everything",
    "- Convulsions",
    "- Lethargic or unconscious",
    "",
    "Then ask: Does the child have cough or difficult breathing?",
    "If yes, the health worker should:",
    "- Count the breaths in one minute. The child must be calm.",
    "- Look for chest indrawing.",
    "- Look and listen for stridor.",
    "- Look and listen for wheezing.",
    "",
    "Fast breathing is:",
    "- 50 breaths per minute or more if the child is 2 months up to 12 months.",
    "- 40 breaths per minute or more if the child is 12 months up to 5 years.",
  ],
  [
    "#Classification table: cough or difficult breathing",
    "",
    "Row 1. Any general danger sign or stridor in calm child.",
    "Classify as SEVERE PNEUMONIA OR VERY SEVERE DISEASE.",
    "Give first dose of an appropriate antibiotic. Refer URGENTLY to hospital.",
    "",
    "Row 2. Chest indrawing or fast breathing.",
    "Classify as PNEUMONIA.",
    "Give oral Amoxicillin for 5 days. Advise the caregiver when to return.",
    "Follow-up in 3 days.",
    "",
    "Row 3. No signs of pneumonia or very severe disease.",
    "Classify as COUGH OR COLD. Soothe the throat. Advise the caregiver when to return.",
    "",
    "If wheezing with either fast breathing or chest indrawing: give a trial of",
    "rapid acting inhaled bronchodilator before classifying.",
  ],
];

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

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../samples/cough-guideline-sample.pdf");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, pdf, "latin1");
console.log("wrote " + out);
