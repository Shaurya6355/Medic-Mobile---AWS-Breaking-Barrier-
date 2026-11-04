import { readFileSync } from "node:fs";
import { ModelSchema, type LogicModel } from "./schema.ts";
import { normalise, type Digest } from "./digest.ts";

export interface BuildInput { guideline: { id: string; name: string }; digest: Digest }
export interface BuildOutput { model: unknown; source: "placeholder" | "agent"; notes: string[] }

/**
 * The model step. AgentCore will implement this interface (which model runs which task is theirs to decide).
 * Whatever it returns is untrusted: buildLogicModel validates it against ModelSchema before anything uses it.
 */
export interface LogicModelBuilder {
  readonly name: string;
  build(input: BuildInput): Promise<BuildOutput>;
}

const TEMPLATE = JSON.parse(readFileSync(new URL("./templates/logic-model.template.json", import.meta.url), "utf8")) as LogicModel;

/**
 * Placeholder until AgentCore is connected. No model runs: it returns the sample cough-pathway template
 * so the review screen has something to render. It does not read the guideline's content.
 */
export const placeholderBuilder: LogicModelBuilder = {
  name: "placeholder-template",
  async build() {
    return {
      model: structuredClone(TEMPLATE),
      source: "placeholder",
      notes: ["No model connected. This is the sample cough-pathway template, not content drafted from this guideline."],
    };
  },
};

export class InvalidModelError extends Error {}

export interface LogicModelEnvelope {
  schemaVersion: 1;
  guidelineId: string;
  builder: string;
  source: "placeholder" | "agent";
  createdAt: string;
  notes: string[];
  /** Deterministic check: how many of the model's source quotes appear verbatim in the digested guideline. */
  quoteCheck: { found: number; total: number; missing: string[] };
  model: LogicModel;
}

export function checkQuotes(model: LogicModel, d: Digest) {
  const haystack = normalise(d.blocks.map(b => b.text).join(" ")).toLowerCase();
  const quotes = Object.entries(model.src).map(([node, [q]]) => [node, q] as const);
  const missing = quotes.filter(([, q]) => !haystack.includes(normalise(q).toLowerCase())).map(([node]) => node);
  return { found: quotes.length - missing.length, total: quotes.length, missing };
}

export async function buildLogicModel(builder: LogicModelBuilder, input: BuildInput): Promise<LogicModelEnvelope> {
  const out = await builder.build(input);
  const parsed = ModelSchema.safeParse(out.model);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map(i => (i.path.join(".") || "(root)") + ": " + i.message).join("; ");
    throw new InvalidModelError(`${builder.name} returned a logic model that fails the schema: ${issues}`);
  }
  return {
    schemaVersion: 1, guidelineId: input.guideline.id, builder: builder.name, source: out.source,
    createdAt: new Date().toISOString(), notes: out.notes, quoteCheck: checkQuotes(parsed.data, input.digest), model: parsed.data,
  };
}
