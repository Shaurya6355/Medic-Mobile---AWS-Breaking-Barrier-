import { z } from "zod";

const Src = z
  .object({ block_id: z.string(), pdf_page: z.number().int(), quote: z.string() })
  .passthrough();

const Draft = z
  .object({
    variable: z.string(),
    op: z.string(),
    value: z.unknown(),
    unit: z.string().nullable(),
    age_band: z.string().nullable(),
  })
  .passthrough();

const Node = z
  .object({
    id: z.string(),
    kind: z.enum(["ask", "look", "count", "decision", "outcome", "action", "advice", "followup", "goto"]),
    text: z.string(),
    parent_id: z.string().nullable(),
    order: z.number().int(),
    clinical: z.boolean(),
    pdf_page: z.number().int(),
    printed_page: z.number().int().nullable(),
    out_of_scope: z.boolean(),
    goto_target: z.string().nullable(),
    src: z.array(Src),
  })
  .passthrough();

const Edge = z
  .object({
    from: z.string(),
    to: z.string(),
    branch_label: z.string().nullable(),
    condition_text: z.string().nullable(),
    draft_condition: Draft.nullable(),
    src: z.array(Src),
  })
  .passthrough();

const Variable = z
  .object({
    id: z.string(),
    label: z.string(),
    type_hint: z.string(),
    unit: z.string().nullable(),
    range_hint: z.string().nullable(),
    used_by: z.array(z.string()),
    src: z.array(Src),
  })
  .passthrough();

const DangerSign = z
  .object({
    id: z.string(),
    text: z.string(),
    condition_text: z.string().nullable(),
    cough_relevant: z.boolean(),
    src: z.array(Src),
  })
  .passthrough();

const Threshold = z
  .object({
    variable: z.string(),
    op: z.string(),
    value: z.number(),
    unit: z.string(),
    age_band: z.string().nullable(),
    src: z.array(Src),
  })
  .passthrough();

const Action = z
  .object({
    id: z.string(),
    type: z.string(),
    drug: z.string().nullable(),
    dose_text: z.string().nullable(),
    age_band: z.string().nullable(),
    frequency: z.string().nullable(),
    duration: z.string().nullable(),
    trigger_node_id: z.string().nullable(),
    clinical: z.literal(true),
    src: z.array(Src),
  })
  .passthrough();

const Followup = z
  .object({
    id: z.string(),
    text: z.string(),
    due_text: z.string().nullable(),
    trigger_node_id: z.string().nullable(),
    src: z.array(Src),
  })
  .passthrough();

const UnclearItem = z
  .object({
    id: z.string(),
    block_id: z.string(),
    quote: z.string(),
    what_is_unclear: z.string(),
    related_ids: z.array(z.string()),
  })
  .passthrough();

export const ExtractionOutput = z.object({
  nodes: z.array(Node),
  edges: z.array(Edge),
  variables: z.array(Variable),
  danger_signs: z.array(DangerSign),
  thresholds: z.array(Threshold),
  actions: z.array(Action),
  followups: z.array(Followup),
  unclear_items: z.array(UnclearItem),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutput>;
