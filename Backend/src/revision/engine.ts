import type { Condition, Model } from "../logic/index.js";
import type { ModelContent } from "../model/modelClient.js";
import type { ExtractionOutput } from "../steps/extractionSchema.js";
import { InstructionOutputSchema, ProposalSchema } from "./proposal.js";
import { allowedTargets, type TargetSet } from "./targets.js";
import { applyProposal } from "./apply.js";
import type { InstructionNote, RevisionComment } from "./types.js";

export { InstructionOutputSchema, ProposalSchema, allowedTargets, applyProposal };
export type { TargetSet };

const NODE_TEXT_MAX = 200;

/** Reviewer text is data: no occurrence of the delimiter characters survives, and control characters go. */
export function neutralize(s: string, max = 5000): string {
  // NFKC folds fullwidth and similar lookalike angle brackets into < and > before matching.
  let t = s.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  t = t.replace(/[\u2039\u2329\u27e8\u3008\u276c\u276e\u2770\ufe64]/g, "<").replace(/[\u203a\u232a\u27e9\u3009\u276d\u276f\u2771\ufe65]/g, ">");
  while (/<<<|>>>/.test(t)) t = t.replace(/<<</g, "< < <").replace(/>>>/g, "> > >");
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}
/** Code, not the model, decides which notes are kept: only notes on a commented item, at most one list entry per comment. */
export function filterNotes(notes: InstructionNote[], comments: RevisionComment[]): InstructionNote[] {
  const refs = new Set(comments.map((c) => c.itemRef));
  return notes.filter((n) => refs.has(n.itemRef)).slice(0, comments.length);
}
const oneLine = (s: string, max: number): string => neutralize(s, max).replace(/\s+/g, " ").trim();
const safeRef = (s: string): string => (/^[A-Za-z0-9_.]{1,120}$/.test(s) ? s : "invalid_ref");

function commentBlocks(comments: RevisionComment[]): ModelContent[] {
  return comments.map((c, i) => ({
    type: "text" as const,
    text: `<<<REVIEWER_COMMENT ${i + 1} item=${safeRef(c.itemRef)} source=${c.source} author="${oneLine(c.author, 80).replace(/"/g, "'")}">>>\n${neutralize(c.text)}\n<<<END_REVIEWER_COMMENT>>>`,
  }));
}

/** The targeted rows of the model, plus the number leaves of each condition with their paths. */
function modelSlice(model: Model, t: TargetSet): unknown {
  const ruleIds = new Set(t.rules);
  const rules = model.rules.filter((r) => ruleIds.has(r.id));
  const outcomes = model.outcomes.filter((o) => t.outcomes.includes(o.id));
  const derived = model.derived.filter((d) => t.derived.includes(d.id));
  const questions = model.questions.filter((q) => t.questions.includes(q.id));
  const open_questions = model.open_questions.filter((q) => t.openQuestions.includes(q.id));

  const leaves: { owner: string; path: number[]; leaf: string }[] = [];
  const walk = (owner: string, c: Condition | "otherwise" | undefined, path: number[]): void => {
    if (c === undefined || c === "otherwise" || path.length > 32) return;
    if ("all" in c || "any" in c) {
      (("all" in c ? c.all : c.any) as Condition[]).forEach((k, i) => walk(owner, k, [...path, i]));
    } else if (c.op !== "is_yes") {
      leaves.push({ owner, path, leaf: `${c.field} ${c.op} ${c.value}` });
    }
  };
  for (const r of rules) if (t.rules.includes(r.id)) walk(`rules.${r.id}`, r.when, []);
  for (const d of derived) walk(`derived.${d.id}`, d.definition, []);
  for (const q of questions) walk(`questions.${q.id}`, q.shown_when, []);

  return {
    rules,
    outcomes,
    derived,
    questions,
    open_questions,
    number_leaves: leaves,
    unknown_refs: t.unknown,
  };
}

export function buildInstructionRequest(a: {
  model: Model;
  comments: RevisionComment[];
  prompt: string;
}): { system: string; content: ModelContent[]; schema: typeof InstructionOutputSchema } {
  const targets = allowedTargets(a.model, a.comments);
  return {
    system: a.prompt,
    content: [
      { type: "text", text: `Current logic model, version ${a.model.meta.version}. Only the items the comments point at are shown.` },
      { type: "text", text: "Model items (JSON):\n" + JSON.stringify(modelSlice(a.model, targets)) },
      { type: "text", text: `There are ${a.comments.length} comment(s). Write one note per comment, in this order.` },
      ...commentBlocks(a.comments),
      { type: "text", text: "Return one JSON object: the instruction and the notes." },
    ],
    schema: InstructionOutputSchema,
  };
}

function extractionSlice(ex: ExtractionOutput): unknown {
  return {
    thresholds: ex.thresholds.map((t, index) => ({ index, variable: t.variable, op: t.op, value: t.value, unit: t.unit, age_band: t.age_band })),
    variables: ex.variables.map((v) => ({ id: v.id, label: v.label, unit: v.unit })),
    actions: ex.actions.map((x) => ({ id: x.id, type: x.type, drug: x.drug, dose_text: x.dose_text, age_band: x.age_band, trigger_node_id: x.trigger_node_id })),
    followups: ex.followups.map((f) => ({ id: f.id, text: f.text, due_text: f.due_text })),
    action_and_advice_nodes: ex.nodes
      .filter((n) => (n.kind === "action" || n.kind === "advice") && !n.out_of_scope)
      .map((n) => ({ id: n.id, kind: n.kind, text: n.text.length > NODE_TEXT_MAX ? `${n.text.slice(0, NODE_TEXT_MAX - 3)}...` : n.text, pdf_page: n.pdf_page })),
  };
}

export function buildProposalRequest(a: {
  model: Model;
  extraction: ExtractionOutput;
  comments: RevisionComment[];
  instruction: string;
  fillPrompt: string;
  revisePrompt: string;
  targets: TargetSet;
}): { system: string; content: ModelContent[]; schema: typeof ProposalSchema } {
  return {
    system: `${a.fillPrompt}\n\n${a.revisePrompt}`,
    content: [
      { type: "text", text: `Revision of logic model version ${a.model.meta.version}. Targeted items of the current model (JSON); "number_leaves" lists the paths for set_threshold:\n` + JSON.stringify(modelSlice(a.model, a.targets)) },
      { type: "text", text: "Extraction items the edits may point at (thresholds by index, the rest by id):\n" + JSON.stringify(extractionSlice(a.extraction)) },
      ...commentBlocks(a.comments),
      { type: "text", text: `<<<REVIEWER_INSTRUCTION>>>\n${neutralize(a.instruction, 5000)}\n<<<END_REVIEWER_INSTRUCTION>>>` },
      { type: "text", text: "Return one JSON object: the proposal." },
    ],
    schema: ProposalSchema,
  };
}
