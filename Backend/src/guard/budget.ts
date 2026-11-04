/** LLM10: cost budget check. Unknown model price fails closed. */
import { cost, type PriceTable } from "../metrics/cost.js";

export interface Usage { modelId: string; inputTokens: number; outputTokens: number }
export type BudgetVerdict = { ok: true; spentUsd: number } | { ok: false; spentUsd: number; reason: string };

export function checkBudget(prices: PriceTable, usages: readonly Usage[], maxUsd: number, maxTokens?: number): BudgetVerdict {
  let spent = 0;
  let tokens = 0;
  for (const u of usages) {
    const c = cost(prices, u.modelId, u.inputTokens, u.outputTokens);
    if (c === undefined) return { ok: false, spentUsd: spent, reason: `no price for model ${u.modelId}` };
    spent += c;
    tokens += u.inputTokens + u.outputTokens;
  }
  if (maxTokens !== undefined && tokens > maxTokens) return { ok: false, spentUsd: spent, reason: "token budget exceeded" };
  if (spent > maxUsd) return { ok: false, spentUsd: spent, reason: "cost budget exceeded" };
  return { ok: true, spentUsd: spent };
}
