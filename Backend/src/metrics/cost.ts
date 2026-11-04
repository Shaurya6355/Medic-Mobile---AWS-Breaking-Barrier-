import { z } from "zod";

const Price = z.object({
  inPerMTok: z.number().finite().nonnegative(),
  outPerMTok: z.number().finite().nonnegative(),
});
const PriceTableSchema = z.record(z.string(), Price);

export type PriceTable = Record<string, { inPerMTok: number; outPerMTok: number }>;

export function cost(
  prices: PriceTable,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = Object.hasOwn(prices, modelId) ? prices[modelId] : undefined;
  if (!price) return undefined;
  return (inputTokens * price.inPerMTok + outputTokens * price.outPerMTok) / 1_000_000;
}

// Configured model ids with no entry in the price table: their cost cannot be computed (DEC-003).
export function unpricedModelIds(prices: PriceTable, modelIds: string[]): string[] {
  return [...new Set(modelIds.filter((id) => !Object.hasOwn(prices, id)))].sort();
}

export function loadPrices(env: NodeJS.ProcessEnv): PriceTable {
  const raw = env.PRICES_JSON;
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PRICES_JSON is not valid JSON");
  }
  const result = PriceTableSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`PRICES_JSON is invalid: ${result.error.message}`);
  }
  return result.data;
}
