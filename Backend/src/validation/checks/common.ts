import type { Answers } from "../../logic/interpreter.js";
import type { Model } from "../../logic/schema.js";
import { getAnalysis, notProvenReason } from "../analysis.js";
import type { Analysis } from "../analysis.js";
import type { CheckContext } from "../finding.js";

export type Sourced = { source?: readonly { page: number; quote: string }[] | undefined };

/** Page and quote params, and the source list, of an item that cites the booklet. */
export function citation(item: Sourced): { params: Record<string, string>; source: { page: number; quote: string }[] } {
  const src = [...(item.source ?? [])];
  const first = src[0];
  if (first === undefined) return { params: {}, source: [] };
  const pages = [...new Set(src.map((x) => x.page))].sort((a, b) => a - b);
  return { params: { page: pages.join(" and "), quote: first.quote }, source: src.map((x) => ({ page: x.page, quote: x.quote })) };
}

/** The analysis when every combination of answers was gone through; otherwise undefined (closedTable reports NOT_PROVEN). */
export function provenAnalysis(ctx: CheckContext): Analysis | undefined {
  const a = getAnalysis(ctx.model, ctx.maxGridPoints);
  return notProvenReason(a) === undefined && a.closed ? a : undefined;
}

/** The analysis whenever it could run, even if only part of the combinations was gone through (a witness found is real). */
export function anyAnalysis(ctx: CheckContext): Analysis | undefined {
  const a = getAnalysis(ctx.model, ctx.maxGridPoints);
  return a.failure === undefined ? a : undefined;
}

/** The simplest of the combinations (fewest "yes" answers, then first in order) that satisfy the filter. */
export function simplestPoint(points: readonly Answers[], filter: (p: Answers) => boolean): Answers | undefined {
  let best: Answers | undefined;
  let bestScore = Infinity;
  for (const p of points) {
    if (!filter(p)) continue;
    let score = 0;
    for (const v of Object.values(p)) if (v === true) score++;
    if (score < bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

export const outcomeTitle = (model: Model, id: string): string => model.outcomes.find((o) => o.id === id)?.title ?? id;
