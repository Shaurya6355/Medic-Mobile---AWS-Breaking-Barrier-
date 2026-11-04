/* Writes samples/cough-guideline-sample.pdf: a small synthetic guideline with a real text layer,
   for testing the pipeline. Synthetic test data, loosely based on the public WHO IMCI chart. Not clinical advice.
   Run: npm run sample-pdf */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 12 pages so every quote in shared/pathway/samples/cough_fast_breathing.v1.json sits on the page it cites. */
const filler = (title: string): string[] => ["#" + title, "", "This page covers another part of the sick child assessment.", "It is not used by the cough pathway."];
const PAGES: string[][] = [
  ["#SAMPLE GUIDELINE - SYNTHETIC TEST DATA - NOT CLINICAL ADVICE", "", "#Caring for the sick child in the community: chart booklet (sample)", "", "Adapted for testing the guideline intake pipeline."],
  filler("Contents"),
  ["#Who this booklet is for", "", "Use this booklet for a child age 2 months up to 5 years.", "A younger or older child: see page 12."],
  filler("Greet the caregiver"),
  [
    "#Ask and look", "",
    "ASK:",
    "- Cough? If yes, for how long?",
    "- Convulsions?",
    "- Is the child not able to drink or feed anything?",
    "- Does the child vomit everything? (vomits everything?)",
    "LOOK:",
    "- Chest indrawing?",
    "- If cough, count breaths in 1 minute.",
    "- Unusually sleepy or unconscious?",
  ],
  [
    "#Decide: danger signs", "",
    "Danger signs include:",
    "- Cough for 14 days or more",
    "- Diarrhoea for 14 days or more",
    "- Convulsions, not able to drink or feed, vomits everything, chest indrawing,",
    "  unusually sleepy or unconscious.",
    "",
    "If ANY danger sign: REFER URGENTLY TO HEALTH FACILITY.",
  ],
  [
    "#Refer urgently", "",
    "If fast breathing or chest indrawing, give first dose of oral antibiotic.",
    "Explain why child needs to go to the health facility.",
    "Write a referral note. Help arrange transport.",
    "FOLLOW UP child on return at least once a week until child is well.",
  ],
  [
    "#Fast breathing", "",
    "In a child age 2 months up to 12 months, 50 breaths or more per minute.",
    "In a child age 12 months up to 5 years, 40 breaths or more per minute.",
    "",
    "Cough (less than 14 days) without fast breathing: no row in this booklet.",
  ],
  [
    "#Treat at home: Fast Breathing", "",
    "Give oral amoxicillin. Give twice daily for 5 days.",
    "Advise the caregiver to return immediately if child cannot drink or feed,",
    "becomes sicker, or has blood in stool.",
    "Follow up child in 3 days.",
  ],
  filler("Diarrhoea"),
  filler("Fever"),
  ["#A child outside the age range", "", "For a child under 2 months or 5 years and older:", "refer child to health facility, write a referral note, and follow up child on return."],
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
