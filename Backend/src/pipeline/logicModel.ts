import { readFileSync } from "node:fs";
import { sources } from "../../../shared/pathway/index.ts";
import { validateSpec, type Diagnostic, type LogicModel } from "./schema.ts";
import { normalise, type Digest } from "./digest.ts";

export interface BuildInput { guideline: { id: string; name: string }; digest: Digest }
export interface BuildOutput { model: unknown; source: "placeholder" | "agent"; notes: string[] }

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
const TEMPLATE = JSON.parse(readFileSync(new URL("../../../shared/pathway/samples/cough_fast_breathing.v1.json", import.meta.url), "utf8")) as LogicModel;

/**
 * Placeholder until AgentCore is connected. No model runs: it returns the sample cough spec (cough_fast_breathing v1)
 * so the review screen has something to render. It does not read the guideline's content.
 */
export const placeholderBuilder: LogicModelBuilder = {
  name: "placeholder-template",
  async build() {
    return {
      model: structuredClone(TEMPLATE),
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
  const norm = (s: string) => normalise(s).toLowerCase();
  const pages = new Map<number, string>();
  d.blocks.forEach(b => pages.set(b.page, (pages.get(b.page) ?? "") + " " + b.text));
  const pageText = new Map([...pages].map(([p, t]) => [p, norm(t)]));
  const all = norm(d.blocks.map(b => b.text).join(" "));
  const out: QuoteCheck = { found: 0, total: 0, onPage: 0, missing: [], wrongPage: [] };
  for (const { path, source } of sources(model)) {
    out.total++;
    const q = norm(source.quote);
    if (!all.includes(q)) { out.missing.push({ path, quote: source.quote }); continue; }
    out.found++;
    if (pageText.get(source.page)?.includes(q)) out.onPage++;
    else out.wrongPage.push({ path, quote: source.quote, cited: source.page, foundOn: [...pageText].filter(([, t]) => t.includes(q)).map(([p]) => p) });
  }
  return out;
}

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
  };
}
