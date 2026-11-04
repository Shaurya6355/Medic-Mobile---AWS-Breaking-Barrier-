import { z } from "zod";

/**
 * The draft the fill_logic model call returns. It is NOT a logic model: it only names
 * items of the extraction by id (questions, actions, follow-ups, danger signs, nodes) or by
 * index (thresholds). The model never writes a cut-off number, an operator, a quote, a page
 * or a file hash; the resolver (resolve.ts) copies those from the extraction.
 *
 * Severity follows the logic model: 1..9, LOWER NUMBER = MORE URGENT.
 */

const MAX_LIST = 200;
const MAX_DEPTH = 12;

const Id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "must be lower_snake_case and start with a letter");
/** An extraction id (node, variable, danger sign, action, follow-up, unclear item) or a draft item id. */
const RefId = z.string().min(1).max(120);
const Text = z.string().trim().min(1).max(2000);

/**
 * A condition tree. Leaves:
 *  - {ref: id}: a yes/no question or a derived item of this draft is yes.
 *  - {threshold: n}: extraction.thresholds[n] holds (its variable, operator, number and age band are copied by code).
 */
export type DraftCondition =
  | { ref: string }
  | { threshold: number }
  | { all: DraftCondition[] }
  | { any: DraftCondition[] };

export const DraftConditionSchema: z.ZodType<DraftCondition> = z.lazy(() =>
  z.union([
    z.object({ ref: Id }).strict(),
    z.object({ threshold: z.number().int().min(0).max(10000) }).strict(),
    z.object({ all: z.array(DraftConditionSchema).min(1).max(MAX_LIST) }).strict(),
    z.object({ any: z.array(DraftConditionSchema).min(1).max(MAX_LIST) }).strict(),
  ]),
);

export const DraftQuestionSchema = z
  .object({
    id: Id,
    label: Text,
    answer_type: z.enum(["integer", "yes_no"]),
    /** At least one link to the extraction; the question's sources come from these. */
    variable_id: RefId.optional(),
    danger_sign_id: RefId.optional(),
    node_id: RefId.optional(),
    /** Ask only when this holds; may only read earlier yes/no questions or thresholds on earlier questions. */
    shown_when: DraftConditionSchema.optional(),
  })
  .strict()
  .refine((q) => q.variable_id !== undefined || q.danger_sign_id !== undefined || q.node_id !== undefined, {
    message: "a question needs variable_id, danger_sign_id or node_id",
  });

export const DraftDerivedSchema = z
  .object({
    id: Id,
    label: Text,
    definition: DraftConditionSchema,
    /** Extraction ids whose quotes support this item (thresholds used are cited automatically). */
    cite: z.array(RefId).max(MAX_LIST).optional(),
  })
  .strict();

export const DraftOutcomeSchema = z
  .object({
    id: Id,
    /** 1..9, LOWER NUMBER = MORE URGENT. */
    severity: z.number().int().min(1).max(9),
    title: Text,
    /** Ids of extraction.actions, or of extraction nodes of kind action or advice. */
    action_ids: z.array(RefId).max(50),
    followup_id: RefId.nullable().optional(),
    cite: z.array(RefId).max(MAX_LIST).optional(),
  })
  .strict();

export const DraftRuleSchema = z
  .object({
    priority: z.number().int().min(1).max(100000),
    when: z.union([DraftConditionSchema, z.literal("otherwise")]),
    outcome: Id,
    cite: z.array(RefId).max(MAX_LIST).optional(),
  })
  .strict();

export const DraftOpenQuestionSchema = z
  .object({
    text: Text,
    route_to: z.enum(["clinician", "program_officer"]),
    /** Extraction ids (including unclear item ids) or draft item ids this question is about. */
    related_ids: z.array(RefId).max(MAX_LIST),
  })
  .strict();

function depth(c: DraftCondition): number {
  // Iterative so a hostile, deeply nested input cannot overflow the stack.
  let max = 0;
  const stack: Array<[DraftCondition, number]> = [[c, 1]];
  while (stack.length > 0) {
    const [n, d] = stack.pop() as [DraftCondition, number];
    if (d > max) max = d;
    if (max > MAX_DEPTH) return max;
    if ("all" in n) for (const k of n.all) stack.push([k, d + 1]);
    else if ("any" in n) for (const k of n.any) stack.push([k, d + 1]);
  }
  return max;
}

export const DraftSchema = z
  .object({
    questions: z.array(DraftQuestionSchema).min(1).max(MAX_LIST),
    derived: z.array(DraftDerivedSchema).max(MAX_LIST),
    outcomes: z.array(DraftOutcomeSchema).min(1).max(MAX_LIST),
    rules: z.array(DraftRuleSchema).min(1).max(MAX_LIST),
    open_questions: z.array(DraftOpenQuestionSchema).max(MAX_LIST),
  })
  .strict()
  .superRefine((d, ctx) => {
    const conds: Array<[string, DraftCondition]> = [
      ...d.questions.flatMap((q, i): Array<[string, DraftCondition]> => (q.shown_when ? [[`questions.${i}.shown_when`, q.shown_when]] : [])),
      ...d.derived.map((x, i): [string, DraftCondition] => [`derived.${i}.definition`, x.definition]),
      ...d.rules.flatMap((r, i): Array<[string, DraftCondition]> => (r.when === "otherwise" ? [] : [[`rules.${i}.when`, r.when]])),
    ];
    for (const [path, c] of conds) {
      if (depth(c) > MAX_DEPTH) ctx.addIssue({ code: "custom", path: path.split("."), message: `condition nesting deeper than ${MAX_DEPTH}` });
    }
  });

export type Draft = z.output<typeof DraftSchema>;
export type DraftQuestion = z.output<typeof DraftQuestionSchema>;
export type DraftOutcome = z.output<typeof DraftOutcomeSchema>;
