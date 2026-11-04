import type { CallRecord, Run, StepRecord } from "../domain/types.js";
import { DEFAULT_AWS_RATES, type AwsRates } from "./awsRates.js";
import { cost, type PriceTable } from "./cost.js";

export interface AwsBreakdown {
  lambdaUsd: number;
  agentcoreUsd: number;
  dynamodbUsd: number;
  s3Usd: number;
  totalUsd: number;
}

export interface Cumulative {
  elapsedMs: number; // since the first step started, includes waiting between steps
  activeMs: number; // sum of step latencies so far
  inputTokens: number;
  outputTokens: number;
  modelCostUsd: number | null;
  awsUsd: number;
  totalUsd: number | null;
}

export interface CallMetrics extends CallRecord {
  modelCostUsd: number | null;
  startOffsetMs: number; // from the first step start
}

export interface StepMetrics {
  step: string;
  attempt: number;
  versionId?: string;
  status: StepRecord["status"];
  startedAt: number;
  endedAt?: number;
  latencyMs: number;
  waitBeforeMs: number; // idle time since the previous step ended (queueing, human wait, retry backoff)
  inputTokens: number;
  outputTokens: number;
  modelCostUsd: number | null;
  aws: AwsBreakdown;
  totalUsd: number | null; // model + AWS extras; null when the model cost is unknown
  calls: CallMetrics[];
  callsRecorded: boolean; // false for records written before per-call metrics existed
  error?: string;
  cumulative: Cumulative;
}

export interface StepSummary {
  step: string;
  attempts: number;
  failedAttempts: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  modelCostUsd: number | null;
  awsUsd: number;
  totalUsd: number | null;
}

export interface RunMetrics {
  runId: string;
  state: string;
  generatedFor: { region: string; ratesAsOf: string };
  totals: {
    wallClockMs: number;
    activeMs: number;
    waitMs: number;
    attempts: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    modelCostUsd: number | null;
    awsUsd: number;
    runOverheadUsd: number;
    totalUsd: number | null;
    unpricedSteps: string[]; // steps with tokens but no price in PRICES_JSON
  };
  byStep: StepSummary[];
  steps: StepMetrics[];
  notes: string[];
}

export interface BuildOptions {
  rates?: AwsRates;
  // With a price table, call-level cost is exact. Without it, a step's cost is split over its calls by tokens.
  prices?: PriceTable;
}

const HOUR_MS = 3_600_000;
const round = (n: number): number => Math.round(n * 1e9) / 1e9;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function awsForStep(s: StepRecord, latencyMs: number, calls: CallRecord[], r: AwsRates): AwsBreakdown {
  const a = r.assumptions;
  const lambdaUsd =
    (latencyMs / 1000) * r.lambda.memoryGb * r.lambda.perGbSecond +
    (a.lambdaInvocationsPerStepAttempt * r.lambda.perMillionRequests) / 1e6;
  const agentcoreMs = sum(calls.filter((c) => c.backend === "agentcore").map((c) => c.latencyMs));
  const agentcoreUsd =
    (agentcoreMs / HOUR_MS) * (r.agentcore.vcpu * r.agentcore.perVcpuHour + r.agentcore.memoryGb * r.agentcore.perGbHour);
  const dynamodbUsd =
    (a.dynamoWritesPerStepAttempt * r.dynamodb.perMillionWriteUnits) / 1e6 +
    (a.dynamoReadsPerStepAttempt * r.dynamodb.perMillionReadUnits) / 1e6;
  const s3Usd = (Object.keys(s.artifactRefs).length * r.s3.perThousandPuts) / 1000;
  return { lambdaUsd, agentcoreUsd, dynamodbUsd, s3Usd, totalUsd: lambdaUsd + agentcoreUsd + dynamodbUsd + s3Usd };
}

export function buildRunMetrics(run: Run, records: StepRecord[], opts: BuildOptions = {}): RunMetrics {
  const rates = opts.rates ?? DEFAULT_AWS_RATES;
  const ordered = [...records].sort((a, b) => a.startedAt - b.startedAt || a.attempt - b.attempt);
  const t0 = ordered[0]?.startedAt ?? run.createdAt;

  let prevEnd: number | undefined;
  let elapsed = 0;
  let active = 0;
  let inTok = 0;
  let outTok = 0;
  let modelCost = 0;
  let modelCostKnown = true;
  let aws = 0;
  const unpriced = new Set<string>();

  const steps: StepMetrics[] = ordered.map((s) => {
    const latencyMs = s.latencyMs ?? (s.endedAt !== undefined ? s.endedAt - s.startedAt : 0);
    const recorded = s.calls ?? [];
    const stepTokens = s.inputTokens + s.outputTokens;
    const calls: CallMetrics[] = recorded.map((c) => ({
      ...c,
      startOffsetMs: c.startedAt - t0,
      modelCostUsd: opts.prices
        ? (cost(opts.prices, c.modelId, c.inputTokens, c.outputTokens) ?? null)
        : s.costUsd === undefined
          ? null
          : stepTokens === 0
            ? 0
            : (s.costUsd * (c.inputTokens + c.outputTokens)) / stepTokens,
    }));
    const awsB = awsForStep(s, latencyMs, recorded, rates);
    const priced = opts.prices && s.modelId ? cost(opts.prices, s.modelId, s.inputTokens, s.outputTokens) : undefined;
    const modelCostUsd = s.costUsd ?? priced ?? (stepTokens === 0 ? 0 : null);
    if (modelCostUsd === null) {
      modelCostKnown = false;
      unpriced.add(s.step);
    } else modelCost += modelCostUsd;
    const waitBeforeMs = prevEnd === undefined ? 0 : Math.max(0, s.startedAt - prevEnd);
    const end = s.endedAt ?? s.startedAt + latencyMs;
    elapsed = Math.max(elapsed, end - t0);
    prevEnd = Math.max(prevEnd ?? end, end);
    active += latencyMs;
    inTok += s.inputTokens;
    outTok += s.outputTokens;
    aws += awsB.totalUsd;
    return {
      step: s.step,
      attempt: s.attempt,
      versionId: s.versionId,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      latencyMs,
      waitBeforeMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      modelCostUsd,
      aws: awsB,
      totalUsd: modelCostUsd === null ? null : modelCostUsd + awsB.totalUsd,
      calls,
      callsRecorded: s.calls !== undefined,
      error: s.error,
      cumulative: {
        elapsedMs: elapsed,
        activeMs: active,
        inputTokens: inTok,
        outputTokens: outTok,
        modelCostUsd: modelCostKnown ? round(modelCost) : null,
        awsUsd: round(aws),
        totalUsd: modelCostKnown ? round(modelCost + aws) : null,
      },
    };
  });

  const byName = new Map<string, StepSummary>();
  for (const m of steps) {
    const cur =
      byName.get(m.step) ??
      ({ step: m.step, attempts: 0, failedAttempts: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, calls: 0, modelCostUsd: 0, awsUsd: 0, totalUsd: 0 } as StepSummary);
    cur.attempts += 1;
    if (m.status === "failed") cur.failedAttempts += 1;
    cur.latencyMs += m.latencyMs;
    cur.inputTokens += m.inputTokens;
    cur.outputTokens += m.outputTokens;
    cur.calls += m.calls.length;
    cur.awsUsd += m.aws.totalUsd;
    cur.modelCostUsd = cur.modelCostUsd === null || m.modelCostUsd === null ? null : cur.modelCostUsd + m.modelCostUsd;
    cur.totalUsd = cur.modelCostUsd === null ? null : cur.modelCostUsd + cur.awsUsd;
    byName.set(m.step, cur);
  }

  const runOverheadUsd = steps.length === 0 ? 0 : (rates.assumptions.sqsRequestsPerRun * rates.sqs.perMillionRequests) / 1e6;
  const notes = [
    `Model cost uses PRICES_JSON per-million-token prices; a model missing from the table has no model cost (shown as unknown).`,
    `AWS extras are ESTIMATES at ${rates.region} list prices (as of ${rates.asOf}): Lambda ${rates.lambda.memoryGb} GB ${rates.lambda.architecture} duration = step latency; AgentCore ${rates.agentcore.vcpu} vCPU / ${rates.agentcore.memoryGb} GB for the duration of each agentcore call; DynamoDB and SQS from per-step request assumptions; S3 PUT per artifact.`,
    `Not included: API Gateway requests (not attributable per run), S3 storage over time, CloudWatch logs, data transfer, and the free tier.`,
  ];
  if (steps.some((s) => !s.callsRecorded)) notes.push("Some steps have no per-call records (they ran before call metrics existed); only their step totals are shown.");

  return {
    runId: run.runId,
    state: run.state,
    generatedFor: { region: rates.region, ratesAsOf: rates.asOf },
    totals: {
      wallClockMs: elapsed,
      activeMs: active,
      waitMs: Math.max(0, elapsed - active),
      attempts: steps.length,
      calls: sum(steps.map((s) => s.calls.length)),
      inputTokens: inTok,
      outputTokens: outTok,
      modelCostUsd: modelCostKnown ? round(modelCost) : null,
      awsUsd: round(aws + runOverheadUsd),
      runOverheadUsd: round(runOverheadUsd),
      totalUsd: modelCostKnown ? round(modelCost + aws + runOverheadUsd) : null,
      unpricedSteps: [...unpriced],
    },
    byStep: [...byName.values()],
    steps,
    notes,
  };
}
