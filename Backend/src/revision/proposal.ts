import { z } from "zod";
import type { InstructionNote, Proposal } from "./types.js";

const ID = /^[a-z][a-z0-9_]*$/;
const outcomeId = z.string().min(1).max(64).regex(ID);
/** Rule ids are free text in the model (R3), so only bound them. */
const ruleId = z.string().min(1).max(200);
const owner = z.string().min(3).max(260).regex(/^(derived|rules|questions)\./);
const extractionId = z.string().min(1).max(120);

const EditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_threshold"), owner, path: z.array(z.number().int().min(0).max(499)).max(32), threshold: z.number().int().min(0).max(10000) }).strict(),
  z.object({ op: z.literal("set_rule_outcome"), rule: ruleId, outcome: outcomeId }).strict(),
  z.object({ op: z.literal("replace_action"), outcome: outcomeId, actionIndex: z.number().int().min(0).max(49), extractionId }).strict(),
  z.object({ op: z.literal("set_follow_up"), outcome: outcomeId, followupId: extractionId.nullable() }).strict(),
]);

export const ProposalSchema: z.ZodType<Proposal> = z
  .object({
    edits: z.array(EditSchema).max(50),
    unsupported: z.array(z.object({ itemRef: z.string().min(1).max(200), reason: z.enum(["not_in_extraction", "needs_clinical_decision", "ambiguous", "other"]) }).strict()).max(50).default([]),
  })
  .strict() as unknown as z.ZodType<Proposal>;

export const InstructionOutputSchema: z.ZodType<{ instruction: string; notes: InstructionNote[] }> = z
  .object({
    instruction: z.string().min(15).max(1500),
    notes: z
      .array(
        z
          .object({
            itemRef: z.string().min(1).max(200),
            understood: z.string().min(1).max(1000),
            feasible: z.enum(["extraction_supported", "needs_human"]),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
