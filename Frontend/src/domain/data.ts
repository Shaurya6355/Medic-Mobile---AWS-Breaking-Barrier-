/* Sample data from the mockup. Synthetic, based on the WHO IMCI 2008 to 2014 revision. Not clinical advice. */
import type { CondKey, FbType, Model, OutKey, Patient, PatientInputs, QType, SignKey, NodeId } from "./types";

export const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function fnv(str: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, "0").slice(0, 8);
}
export const hashOf = (m: Model) => fnv(JSON.stringify(m));

export const COND: Record<CondKey, string> = { ci: "Chest indrawing", stridor: "Stridor in a calm child", fast: "Fast breathing for age" };
export const SIGNS: Record<SignKey, string> = { drink: "Not able to drink or breastfeed", vomit: "Vomits everything", conv: "Convulsions", leth: "Lethargic or unconscious" };
export const OUTCODE: Record<OutKey, string> = { o1: "severe_pneumonia", o2: "pneumonia", o3: "no_pneumonia" };
export const OUTCOLOR: Record<OutKey, string> = { o1: "pink", o2: "yellow", o3: "green" };
export const QORDER = ["cough", "age_months", "resp_rate", "chest_indrawing", "stridor", "danger_signs", "wheeze", "cough_syrup"];
export const QTYPE: Record<QType, string> = { yesno: "yes/no", int: "integer", multi: "select multiple" };
export const NODE_IDS: NodeId[] = ["start", "d1", "d2", "d3", "o1", "o2", "o3", "f1"];
export const SRC_NUMS = [2, 5, 12, 50, 40, 3, 7, 60];
export const FB_TYPES: [FbType, string][] = [["wording", "Wording"], ["value", "Threshold or value"], ["show", "Show condition"], ["source", "Wrong source"], ["remove", "Remove"], ["add", "Add missing question"]];
export const fbLabel = (t?: FbType) => (FB_TYPES.find(x => x[0] === t) || ["", ""])[1];

export const AI_DRAFT: Model = {
  start: { ageMin: 2, ageMax: 60 },
  d1: { q: "Any general danger sign?", signs: ["drink", "vomit", "conv", "leth"] },
  d2: { q: "Stridor in calm child?", conds: ["stridor"], hint: "Look and listen while the child is calm." },
  d3: { q: "Chest indrawing or fast breathing?", conds: ["ci", "fast"], cut: 12, young: 50, old: 40, hint: "Count the breaths in one minute. The child must be calm." },
  o1: { title: "Severe pneumonia or very severe disease", note: "Give first dose of antibiotic. Refer URGENTLY to the health facility." },
  o2: { title: "Pneumonia", note: "Give oral amoxicillin. Advise the caregiver when to return." },
  o3: { title: "No pneumonia: cough or cold", note: "Soothe the throat. Advise the caregiver when to return." },
  f1: { title: "Pneumonia follow-up visit", due: 3, end: 7 },
  src: {
    start: ["Assess and classify the sick child aged 2 months up to 5 years", "section heading"],
    d1: ["Any general danger sign", "classification table, row 1"],
    d2: ["Any general danger sign or stridor in calm child", "classification table, row 1"],
    d3: ["Chest indrawing or fast breathing", "classification table, row 2"],
    o1: ["Give first dose of an appropriate antibiotic. Refer URGENTLY to hospital", "treatment column, row 1"],
    o2: ["Give oral Amoxicillin", "treatment column, row 2"],
    o3: ["No signs of pneumonia or very severe disease", "classification table, row 3"],
    f1: ["Follow-up in 3 days", "treatment column, row 2"],
  },
  questions: {
    cough: { type: "yesno", label: "Does the child have cough or difficult breathing?", showIf: "", quote: "Does the child have cough or difficult breathing?" },
    age_months: { type: "int", label: "Child's age in months", showIf: "", quote: "Assess and classify the sick child aged 2 months up to 5 years" },
    resp_rate: { type: "int", label: "Count the breaths in one minute", showIf: "cough = yes", quote: "Count the breaths in one minute" },
    chest_indrawing: { type: "yesno", label: "Is there chest indrawing?", showIf: "cough = yes", quote: "Look for chest indrawing" },
    stridor: { type: "yesno", label: "Is there stridor in a calm child?", showIf: "cough = yes", quote: "Look and listen for stridor" },
    danger_signs: { type: "multi", label: "General danger signs", showIf: "", quote: "Check for general danger signs" },
    wheeze: { type: "yesno", label: "Is there wheezing?", showIf: "cough = yes", quote: "Look and listen for wheezing" },
  },
};

/** The version live in CHT today. */
export const V3: Model = (() => {
  const v = clone(AI_DRAFT);
  v.d2 = { q: "Chest indrawing or stridor in calm child?", conds: ["ci", "stridor"], hint: "Look and listen while the child is calm." };
  v.d3 = { ...v.d3, q: "Fast breathing?", conds: ["fast"] };
  v.src.d2 = ["Any general danger sign or chest indrawing or stridor in calm child", "2008 booklet, classification table, row 1"];
  v.src.d3 = ["Fast breathing", "2008 booklet, classification table, row 2"];
  v.questions.chest_indrawing = { ...v.questions.chest_indrawing, label: "Chest indrawing?" };
  delete v.questions.wheeze;
  v.questions.cough_syrup = { type: "yesno", label: "Has the child been given cough syrup?", showIf: "cough = yes", quote: "Cited in the 2008 source only" };
  return v;
})();
export const V3_HASH = hashOf(V3);

export const GRID: Patient[] = (() => {
  const out: Patient[] = []; let n = 1;
  for (const age of [2, 6, 11, 12, 24, 59]) for (const rr of [30, 39, 40, 49, 50, 55]) for (const ci of [false, true]) for (const stridor of [false, true]) for (const danger of [[], ["conv"]] as SignKey[][])
    out.push({ id: "P-" + String(n++).padStart(3, "0"), age, rr, ci, stridor, danger });
  return out;
})();

export const GOLDEN: [string, PatientInputs, OutKey][] = [
  ["G-01", { age: 8, rr: 52, ci: false, stridor: false, danger: [] }, "o2"],
  ["G-02", { age: 8, rr: 45, ci: false, stridor: false, danger: [] }, "o3"],
  ["G-03", { age: 30, rr: 42, ci: false, stridor: false, danger: [] }, "o2"],
  ["G-04", { age: 30, rr: 38, ci: false, stridor: false, danger: [] }, "o3"],
  ["G-05", { age: 12, rr: 40, ci: false, stridor: false, danger: [] }, "o2"],
  ["G-06", { age: 11, rr: 49, ci: false, stridor: false, danger: [] }, "o3"],
  ["G-07", { age: 18, rr: 30, ci: true, stridor: false, danger: [] }, "o2"],
  ["G-08", { age: 6, rr: 40, ci: false, stridor: true, danger: [] }, "o1"],
  ["G-09", { age: 24, rr: 30, ci: false, stridor: false, danger: ["conv"] }, "o1"],
  ["G-10", { age: 3, rr: 60, ci: true, stridor: false, danger: [] }, "o2"],
  ["G-11", { age: 48, rr: 35, ci: false, stridor: false, danger: [] }, "o3"],
  ["G-12", { age: 9, rr: 50, ci: false, stridor: false, danger: [] }, "o2"],
];

export const PATHWAYS = ["Cough or difficult breathing", "Diarrhoea", "Fever (malaria area)", "Malnutrition danger signs"];
