/* Sample data. Synthetic, loosely based on the WHO/UNICEF community chart booklet. Not clinical advice.
   DRAFT is the hardcoded logic model JSON (the same file the backend placeholder serves). Live mode fetches it
   from the pipeline instead; the rest of the app only ever sees the Spec shape. */
import draftJson from "../../../shared/pathway/samples/cough_fast_breathing.v1.json";
import draftBJson from "../../../shared/pathway/samples/cough_fast_breathing.v1.draftB.json";
import pagesJson from "../../../shared/pathway/samples/cough-guideline.pages.json";
import { validateSpec, type Answers, type Spec } from "../../../shared/pathway/index.ts";
import type { Evidence, FbType } from "./types";

export const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function fnv(str: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, "0").slice(0, 8);
}
export const hashOf = (m: Spec) => fnv(JSON.stringify(m));

/** Validate a logic model JSON from anywhere (bundled sample, pipeline, file). Throws with the first errors. */
export function loadSpec(x: unknown, from: string): Spec {
  const { spec, diagnostics } = validateSpec(x);
  if (!spec) throw new Error(from + " is not a valid logic model: " + diagnostics.filter(d => d.level === "error").slice(0, 3).map(d => (d.path ? d.path + ": " : "") + d.message).join("; "));
  return spec;
}

/** Hardcoded dummy logic model until the pipeline produces real ones. */
export const DRAFT: Spec = loadSpec(draftJson, "The bundled sample logic model");

/** The version live in CHT today (synthetic): no cough-duration question, older wording, antibiotic before referral only for fast breathing. */
/** Sample mode: the sample guideline's text and a sample draft B, so every check can run without the backend. */
export const SAMPLE_EVIDENCE: Evidence = {
  pages: (pagesJson as string[][]).map((lines, i) => ({ page: i + 1, text: lines.map(l => l.replace(/^#/, "")).join("\n") })),
  pagesFrom: "Sample guideline text (cough-guideline-sample.pdf, 12 pages)",
  draftB: loadSpec(draftBJson, "The bundled sample draft B"),
  draftBFrom: "Draft B: sample placeholder until the model pipeline produces one",
};

export const V3: Spec = (() => {
  const v = clone(DRAFT);
  v.questions = v.questions.filter(q => q.id !== "cough_days");
  v.questions.find(q => q.id === "chest_indrawing")!.label = "Chest indrawing?";
  v.questions.push({ id: "wheeze", order: 10, label: "Is there wheezing?", answer_type: "yes_no", required: true, shown_when: { field: "cough", op: "is_yes" }, origin: "guideline", source: { page: 5, quote: "Wheeze?" } });
  const ds = v.derived.find(d => d.id === "danger_sign")!;
  if ("any" in ds.definition) ds.definition = { any: ds.definition.any.slice(1) };
  v.rules.find(r => r.id === "R2")!.when = { all: [{ field: "danger_sign", op: "is_yes" }, { field: "fast_breathing", op: "is_yes" }] };
  v.outcomes.find(o => o.id === "treat_fast_breathing_at_home")!.title = "Pneumonia: give amoxicillin, follow up in 3 days";
  return v;
})();
export const V3_HASH = hashOf(V3);

/** Golden cases per pathway: hand-checked answers and the outcome the guideline expects. */
const base: Answers = { age_months: 24, cough: true, cough_days: 3, convulsions: false, not_able_to_drink_or_feed: false, vomits_everything: false, chest_indrawing: false, breaths_per_minute: 30, unusually_sleepy: false };
const g = (id: string, a: Answers, exp: string): [string, Answers, string] => [id, { ...base, ...a }, exp];
export const GOLDEN: Record<string, [id: string, answers: Answers, expected: string][]> = {
  cough_fast_breathing: [
    g("G-01", { age_months: 8, breaths_per_minute: 52 }, "treat_fast_breathing_at_home"),
    g("G-02", { age_months: 8, breaths_per_minute: 45 }, "cough_no_fast_breathing"),
    g("G-03", { age_months: 30, breaths_per_minute: 42 }, "treat_fast_breathing_at_home"),
    g("G-04", { age_months: 30, breaths_per_minute: 38 }, "cough_no_fast_breathing"),
    g("G-05", { age_months: 12, breaths_per_minute: 40 }, "treat_fast_breathing_at_home"),
    g("G-06", { age_months: 11, breaths_per_minute: 49 }, "cough_no_fast_breathing"),
    g("G-07", { chest_indrawing: true }, "refer_urgent_with_antibiotic"),
    g("G-08", { convulsions: true }, "refer_urgent"),
    g("G-09", { convulsions: true, breaths_per_minute: 45 }, "refer_urgent_with_antibiotic"),
    g("G-10", { cough_days: 14 }, "refer_urgent"),
    g("G-11", { age_months: 1 }, "refer_outside_age_range"),
    g("G-12", { age_months: 60 }, "refer_outside_age_range"),
    g("G-13", { cough: false }, "no_cough"),
  ],
};

export const FB_TYPES: [FbType, string][] = [["wording", "Wording"], ["value", "Threshold or value"], ["logic", "Rule logic"], ["show", "Show condition"], ["source", "Wrong source"], ["remove", "Remove"], ["add", "Add missing question"]];
export const fbLabel = (t?: FbType) => (FB_TYPES.find(x => x[0] === t) || ["", ""])[1];

/** Outcome colour by severity (1 = most severe). */
export const sevColor = (s: number) => (s <= 2 ? "pink" : s === 3 ? "yellow" : "green");

export const PATHWAYS = ["Cough or difficult breathing", "Diarrhoea", "Fever (malaria area)", "Malnutrition danger signs"];
