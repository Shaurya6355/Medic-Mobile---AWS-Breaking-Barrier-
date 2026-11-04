import { readFileSync } from "node:fs";
import { quoteResults } from "../../../shared/pathway/index.ts";
import { validateSpec, type Diagnostic, type LogicModel } from "./schema.ts";
import type { Digest } from "./digest.ts";

export interface BuildInput { guideline: { id: string; name: string }; digest: Digest }
export interface BuildOutput {
  model: unknown; source: "placeholder" | "agent"; notes: string[];
  /** Draft B: a second, independent draft of the same pathway. The cross check compares it with the main draft. */
  alt?: unknown;
}

/**
 * The model step. AgentCore will implement this interface (which model runs which task is theirs to decide).
 * It must return a pathway spec (schema_version 1.0). Whatever it returns is untrusted: buildLogicModel runs the
 * shared compiler's structural and semantic checks before anything uses it.
 */
export interface LogicModelBuilder {
  readonly name: string;
  build(input: BuildInput): Promise<BuildOutput>;
}

/** Hardcoded dummy spec, shared with the UI's sample mode. */
const sample = (f: string) => JSON.parse(readFileSync(new URL("../../../shared/pathway/samples/" + f, import.meta.url), "utf8")) as LogicModel;
const TEMPLATE = sample("cough_fast_breathing.v1.json");
const TEMPLATE_B = sample("cough_fast_breathing.v1.draftB.json");

/**
 * Placeholder until AgentCore is connected. No model runs: it returns the sample cough spec (cough_fast_breathing v1)
 * so the review screen has something to render. It does not read the guideline's content.
 */
export const placeholderBuilder: LogicModelBuilder = {
  name: "placeholder-template",
  async build() {
    return {
      model: structuredClone(TEMPLATE),
      alt: structuredClone(TEMPLATE_B),
      source: "placeholder",
      notes: ["No model connected. This is the hardcoded cough_fast_breathing v1 spec, not content drafted from this guideline."],
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
  quoteCheck: QuoteCheck;
  /** Compiler warnings (errors reject the model). */
  diagnostics: Diagnostic[];
  model: LogicModel;
  /** Draft B for the cross check, or null when the builder gave none or it failed the compiler checks. */
  draftB: LogicModel | null;
}

export interface QuoteCheck {
  found: number; total: number;
  /** Of the quotes found, how many are on the page they cite. */
  onPage: number;
  missing: { path: string; quote: string }[];
  wrongPage: { path: string; quote: string; cited: number; foundOn: number[] }[];
}

/** Deterministic: every source quote must appear verbatim (case and whitespace aside), ideally on the page it cites. */
export function checkQuotes(model: LogicModel, d: Digest): QuoteCheck {
  const rs = quoteResults(model, pagesOf(d));
  return {
    found: rs.filter(r => r.found).length, total: rs.length, onPage: rs.filter(r => r.onPage).length,
    missing: rs.filter(r => !r.found).map(r => ({ path: r.path, quote: r.source.quote })),
    wrongPage: rs.filter(r => r.found && !r.onPage).map(r => ({ path: r.path, quote: r.source.quote, cited: r.source.page, foundOn: r.foundOn })),
  };
}
/** The digest as page texts: what the review UI's quote check reads. */
export const pagesOf = (d: Digest) => {
  const m = new Map<number, string>();
  d.blocks.forEach(b => m.set(b.page, (m.get(b.page) ? m.get(b.page) + "\n" : "") + b.text));
  return [...m].map(([page, text]) => ({ page, text }));
};

export async function buildLogicModel(builder: LogicModelBuilder, input: BuildInput): Promise<LogicModelEnvelope> {
  const out = await builder.build(input);
  const { spec, diagnostics } = validateSpec(out.model);
  if (!spec) {
    const issues = diagnostics.filter(x => x.level === "error").slice(0, 5).map(x => (x.path || "(root)") + ": " + x.message).join("; ");
    throw new InvalidModelError(`${builder.name} returned a logic model that fails the compiler checks: ${issues}`);
  }
  return {
    schemaVersion: 1, guidelineId: input.guideline.id, builder: builder.name, source: out.source,
    createdAt: new Date().toISOString(), notes: out.notes, quoteCheck: checkQuotes(spec, input.digest), diagnostics, model: spec,
    draftB: out.alt === undefined ? null : validateSpec(out.alt).spec ?? null,
  };
}
