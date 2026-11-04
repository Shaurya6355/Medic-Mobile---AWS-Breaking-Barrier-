import type { StepRecord } from "../domain/types.js";
import type { Revision } from "../revision/types.js";

// One measured piece of work: a pipeline step attempt or one revision model call (DEC-003).
export interface UsageRow {
  process: string;
  versionId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  modelId?: string;
  latencyMs: number;
}

export interface MetricsTotals {
  inputTokens: number;
  outputTokens: number;
  // Sum of the priced rows; null when no row is priced. Incomplete when unpricedModels is not empty.
  costUsd: number | null;
  // Sum of process time, not wall-clock time.
  latencyMs: number;
  // Models that used tokens but have no entry in PRICES_JSON, so their cost is missing from costUsd.
  unpricedModels: string[];
}

export interface RunMetrics {
  totals: MetricsTotals;
  byProcess: Record<string, MetricsTotals>;
  byVersion: Record<string, MetricsTotals>;
}

export function rowFromStep(s: StepRecord): UsageRow {
  return {
    process: s.step,
    ...(s.versionId !== undefined ? { versionId: s.versionId } : {}),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    ...(s.modelId !== undefined ? { modelId: s.modelId } : {}),
    latencyMs: s.latencyMs ?? 0,
  };
}

export function rowsFromRevision(r: Revision): UsageRow[] {
  return r.usage.map((u) => ({
    process: "revision",
    versionId: String(r.fromVersion),
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
    ...(u.modelId !== undefined ? { modelId: u.modelId } : {}),
    latencyMs: u.latencyMs ?? 0,
  }));
}

function totalsOf(rows: UsageRow[]): MetricsTotals {
  const priced = rows.filter((r) => r.costUsd !== undefined);
  const unpriced = new Set<string>();
  for (const r of rows) {
    if (r.costUsd === undefined && r.inputTokens + r.outputTokens > 0 && r.modelId !== undefined) unpriced.add(r.modelId);
  }
  return {
    inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
    costUsd: priced.length === 0 ? null : priced.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    latencyMs: rows.reduce((a, r) => a + r.latencyMs, 0),
    unpricedModels: [...unpriced].sort(),
  };
}

function groupTotals(rows: UsageRow[], key: (r: UsageRow) => string | undefined): Record<string, MetricsTotals> {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === undefined) continue;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  return Object.fromEntries([...groups].map(([k, list]) => [k, totalsOf(list)]));
}

export function summarize(rows: UsageRow[]): RunMetrics {
  return {
    totals: totalsOf(rows),
    byProcess: groupTotals(rows, (r) => r.process),
    byVersion: groupTotals(rows, (r) => r.versionId),
  };
}
