import { z } from "zod";
import type { RevisionEngine } from "../../../src/revision/service.js";
import type { InstructionNote, Proposal, RevisionComment } from "../../../src/revision/types.js";
import type { Model } from "../../../src/logic/index.js";

export const INSTRUCTION_RAW = JSON.stringify({
  instruction: "Raise the fast breathing threshold as the comment asks.",
  notes: [{ itemRef: "rules.R1", understood: "The reviewer wants a different threshold.", feasible: "extraction_supported" }],
});
export const PROPOSAL_RAW = JSON.stringify({ edits: [], unsupported: [] });

/** A stand-in for the real engine: records what the service passes, and applies by changing only the meta. */
export class FakeEngine implements RevisionEngine {
  instructionArgs: { comments: RevisionComment[]; prompt: string }[] = [];
  proposalArgs: { instruction: string; fillPrompt: string; revisePrompt: string; targets: unknown; comments: RevisionComment[] }[] = [];
  applyArgs: { revision: { id: string; fromVersion: number; nowIso: string; instruction: string } }[] = [];
  /** false: applyProposal returns no model (nothing could be applied). */
  produce = true;
  throwInApply = false;

  filterNotes(notes: InstructionNote[], comments: RevisionComment[]): InstructionNote[] {
    const refs = new Set(comments.map((c) => c.itemRef));
    return notes.filter((n) => refs.has(n.itemRef)).slice(0, comments.length);
  }
  allowedTargets(_m: Model, comments: RevisionComment[]): unknown {
    return { items: comments.map((c) => c.itemRef) };
  }
  buildInstructionRequest(a: { model: Model; comments: RevisionComment[]; prompt: string }) {
    this.instructionArgs.push({ comments: a.comments, prompt: a.prompt });
    return {
      system: "SYSTEM-1",
      content: [{ type: "text" as const, text: "comments" }],
      schema: z.object({ instruction: z.string(), notes: z.array(z.any()) }) as never,
    };
  }
  buildProposalRequest(a: Parameters<RevisionEngine["buildProposalRequest"]>[0]) {
    this.proposalArgs.push({ instruction: a.instruction, fillPrompt: a.fillPrompt, revisePrompt: a.revisePrompt, targets: a.targets, comments: a.comments });
    return {
      system: a.fillPrompt + "\n" + a.revisePrompt,
      content: [{ type: "text" as const, text: a.instruction }],
      schema: z.object({ edits: z.array(z.any()), unsupported: z.array(z.any()) }) as unknown as z.ZodType<Proposal>,
    };
  }
  applyProposal(a: Parameters<RevisionEngine["applyProposal"]>[0]) {
    this.applyArgs.push({ revision: a.revision });
    if (this.throwInApply) throw new Error("apply exploded");
    if (!this.produce) return { model: undefined, applied: [], refused: [], questionsAdded: ["Q-new"] };
    const m = structuredClone(a.model);
    m.meta.version = a.revision.fromVersion + 1;
    m.meta.parent_version = a.revision.fromVersion;
    return { model: m, applied: [{ edit: { op: "set_follow_up" as const, outcome: "o", followupId: null }, summary: "changed" }], refused: [], questionsAdded: [] };
  }
}
