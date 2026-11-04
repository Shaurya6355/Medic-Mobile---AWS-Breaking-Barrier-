/**
 * Pure XLSForm builder: logic model -> survey / choices / settings rows, the form's
 * properties.json and the sourcemap. No I/O; the xlsx writer serialises the result.
 */
import { deriveFlow, effectiveShownWhen, type Flow, type Model, type Source } from "../logic/index.js";
import { flowOptionsFor } from "./flowMode.js";
import { AGE_FIELD } from "./readiness.js";
import type { CompileSettings, SourceRef, SourcemapEntry } from "./types.js";
import {
  ageBandXpath,
  conditionToXpath,
  constraintXpath,
  derivedCalculation,
  flowRelevanceToXpath,
  outcomeCalculation,
  outcomeRelevant,
  type XpathContext,
} from "./xpath.js";

export interface SurveyRow {
  type: string;
  name: string;
  label?: string;
  required?: string;
  relevant?: string;
  appearance?: string;
  constraint?: string;
  constraint_message?: string;
  calculation?: string;
  default?: string;
}

/** Row keys in sheet column order; the xlsx header maps label -> label::en etc. */
export const SURVEY_COLUMNS = [
  "type",
  "name",
  "label",
  "required",
  "relevant",
  "appearance",
  "constraint",
  "constraint_message",
  "calculation",
  "default",
] as const;

export const SURVEY_HEADERS: Record<(typeof SURVEY_COLUMNS)[number], string> = {
  type: "type",
  name: "name",
  label: "label::en",
  required: "required",
  relevant: "relevant",
  appearance: "appearance",
  constraint: "constraint",
  constraint_message: "constraint_message::en",
  calculation: "calculation",
  default: "default",
};

export interface ChoiceRow {
  list_name: string;
  name: string;
  label: string;
}

export interface SettingsRow {
  form_title: string;
  form_id: string;
  version: string;
  default_language: string;
  /** "pages": one screen per top-level group, as in CHT's own app forms (h:body class="pages"). */
  style: "pages";
}

export interface FormProperties {
  title: Array<{ locale: string; content: string }>;
  icon: string;
  context: { person: boolean; place: boolean };
}

export interface BuiltForm {
  formId: string;
  survey: SurveyRow[];
  choices: ChoiceRow[];
  settings: SettingsRow;
  properties: FormProperties;
  sourcemap: SourcemapEntry[];
}

const srcs = (s: Source[] | undefined): SourceRef[] => (s ?? []).map((x) => ({ page: x.page, quote: x.quote }));

/**
 * `flow`: the derived question flow to apply (compileSnapshot passes the verified one). When
 * omitted it is derived from settings.flowMode (default "minimal"); null = authored shown_when only.
 */
export function buildForm(model: Model, settings: CompileSettings, version: string, flow?: Flow | null): BuiltForm {
  const mode = settings.flowMode ?? "minimal";
  if (flow === undefined) {
    const opts = flowOptionsFor(mode);
    flow = opts === null ? null : deriveFlow(model, opts);
  }
  const formId = model.meta.pathway_id;
  const xlsx = `forms/app/${formId}.xlsx`;
  const ctx: XpathContext = { derived: new Set(model.derived.map((d) => d.id)) };
  const survey: SurveyRow[] = [];
  const sourcemap: SourcemapEntry[] = [];

  const push = (r: SurveyRow): number => {
    survey.push(r);
    return survey.length + 1; // worksheet row (header is row 1)
  };
  const map = (row: number, name: string, kind: SourcemapEntry["kind"], item: string, origin: SourcemapEntry["origin"], sources: Source[] | undefined, extra: Partial<SourcemapEntry> = {}): void => {
    sourcemap.push({ target: { file: xlsx, sheet: "survey", row, name }, kind, item, origin, sources: srcs(sources), ...extra });
  };

  // ---- CHT inputs group (report -> patient link), as in the cht-core reference forms ----
  const selector = settings.contactTypes.person ? "select-contact type-person" : "select-contact type-clinic";
  push({ type: "begin group", name: "inputs", relevant: "./source = 'user'", appearance: "field-list" });
  push({ type: "hidden", name: "source", label: "Source", default: "user" });
  push({ type: "hidden", name: "source_id", label: "Source ID" });
  push({ type: "begin group", name: "contact", label: "Contact" });
  push({ type: "string", name: "_id", label: "Who is this assessment for?", appearance: selector });
  push({ type: "hidden", name: "name", label: "Name" });
  push({ type: "hidden", name: "patient_id", label: "Patient ID" });
  push({ type: "end group", name: "contact" });
  push({ type: "end group", name: "inputs" });
  push({ type: "calculate", name: "patient_uuid", calculation: "../inputs/contact/_id" });
  push({ type: "calculate", name: "patient_id", calculation: "../inputs/contact/patient_id" });
  push({ type: "calculate", name: "patient_name", calculation: "../inputs/contact/name" });

  // ---- questions ----
  // One question per screen: with style=pages every top-level group is a page, so each question gets
  // its own unlabelled field-list group (only the question text shows). The group carries the
  // question's relevant so a skipped question's page disappears; the question keeps its own too.
  // With a derived flow the relevant is the authored shown_when AND the flow condition (is_no as
  // = 'no', never as false()), on the row and on its group.
  for (const q of model.questions) {
    const r: SurveyRow =
      q.answer_type === "yes_no"
        ? { type: "select_one yes_no", name: q.id, label: q.label }
        : { type: "integer", name: q.id, label: q.label };
    if (q.required) r.required = "yes";
    const withFlow = flow !== null && (flow.shownWhen[q.id] ?? null) !== null;
    const relevant = flow ? flowRelevanceToXpath(effectiveShownWhen(model, flow, q.id), ctx) : q.shown_when ? conditionToXpath(q.shown_when, ctx) : undefined;
    if (relevant !== undefined) r.relevant = relevant;
    if (q.constraint) {
      r.constraint = constraintXpath(q.constraint.min, q.constraint.max);
      r.constraint_message = q.constraint.message;
    }
    const group: SurveyRow = { type: "begin group", name: `q_${q.id}`, appearance: "field-list" };
    if (r.relevant) group.relevant = r.relevant;
    push(group);
    map(push(r), q.id, "question", q.id, q.origin, q.source, withFlow ? { flowCondition: mode } : {});
    push({ type: "end group", name: `q_${q.id}` });
  }

  // ---- derived values and the outcome ----
  for (const d of model.derived) {
    map(push({ type: "calculate", name: d.id, calculation: derivedCalculation(d.definition, ctx) }), d.id, "derived", d.id, d.origin, d.source);
  }
  const outcomeRow = push({ type: "calculate", name: "outcome", calculation: outcomeCalculation(model.rules, ctx) });
  for (const r of model.rules) map(outcomeRow, "outcome", "rule", r.id, r.origin, r.source);

  // ---- results ----
  push({ type: "begin group", name: "results", label: "Result", appearance: "field-list" });
  for (const o of model.outcomes) {
    const name = `outcome_${o.id}`;
    const label = [o.title, ...o.actions.map((a) => a.text)].join("\n");
    map(push({ type: "note", name, label, relevant: outcomeRelevant(o.id) }), name, "outcome_note", o.id, o.origin, o.source);
    o.actions.forEach((a, ai) => {
      (a.dose_by_age ?? []).forEach((band, bi) => {
        const dn = `${name}_dose_${ai + 1}_${bi + 1}`;
        const total = band.total !== undefined ? ` (total ${band.total})` : "";
        const row = push({
          type: "note",
          name: dn,
          label: `Age ${band.age_months_min} to under ${band.age_months_below} months: ${band.dose}${total}`,
          relevant: `${outcomeRelevant(o.id)} and ${ageBandXpath(AGE_FIELD, band.age_months_min, band.age_months_below)}`,
        });
        map(row, dn, "dose_note", o.id, a.origin, a.source);
      });
    });
  }
  push({ type: "end group", name: "results" });

  return {
    formId,
    survey,
    choices: [
      { list_name: "yes_no", name: "yes", label: "Yes" },
      { list_name: "yes_no", name: "no", label: "No" },
    ],
    settings: { form_title: settings.formTitle, form_id: formId, version, default_language: "en", style: "pages" },
    properties: {
      title: [{ locale: "en", content: settings.formTitle }],
      icon: settings.icon,
      context: { person: settings.contactTypes.person, place: settings.contactTypes.place },
    },
    sourcemap,
  };
}
