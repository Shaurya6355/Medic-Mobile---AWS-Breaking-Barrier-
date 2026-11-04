// AWS list-price rates for the cost ESTIMATE of everything that is not a model token (region us-west-2).
//
// IMPORTANT: these are list prices from public pages, not read from the AWS Price List API. The
// Lambda, API Gateway, DynamoDB, SQS and S3 figures are the standard published rates (the same in
// us-east-1 and us-west-2 for these services). The AgentCore Runtime rate is the one to verify: public
// sources disagree (v1 vs v2). Verify against the pages in `sources` before quoting any number, and
// override with AWS_RATES_JSON (a partial object, merged over these defaults).
export interface AwsRates {
  region: string;
  asOf: string;
  lambda: { architecture: "arm64" | "x86_64"; memoryGb: number; perGbSecond: number; perMillionRequests: number };
  agentcore: {
    // Assumed size of the AgentCore Runtime session that serves one model call.
    vcpu: number;
    memoryGb: number;
    perVcpuHour: number;
    perGbHour: number;
  };
  dynamodb: { perMillionWriteUnits: number; perMillionReadUnits: number };
  s3: { perThousandPuts: number; perThousandGets: number; perGbMonth: number };
  sqs: { perMillionRequests: number };
  apiGateway: { perMillionHttpRequests: number };
  // Per-step usage assumptions for items that are not recorded per request.
  assumptions: {
    lambdaInvocationsPerStepAttempt: number;
    dynamoWritesPerStepAttempt: number; // appendStep + updateStep + 2 audit events
    dynamoReadsPerStepAttempt: number; // the engine lists steps and runs around each attempt
    sqsRequestsPerRun: number; // send, receive, delete
  };
  sources: Record<string, string>;
}

export const DEFAULT_AWS_RATES: AwsRates = {
  region: "us-west-2",
  asOf: "2026-11-04",
  lambda: { architecture: "arm64", memoryGb: 2, perGbSecond: 0.0000133334, perMillionRequests: 0.2 },
  agentcore: { vcpu: 1, memoryGb: 2, perVcpuHour: 0.0895, perGbHour: 0.00945 },
  dynamodb: { perMillionWriteUnits: 0.625, perMillionReadUnits: 0.125 },
  s3: { perThousandPuts: 0.005, perThousandGets: 0.0004, perGbMonth: 0.023 },
  sqs: { perMillionRequests: 0.4 },
  apiGateway: { perMillionHttpRequests: 1.0 },
  assumptions: {
    lambdaInvocationsPerStepAttempt: 1,
    dynamoWritesPerStepAttempt: 4,
    dynamoReadsPerStepAttempt: 3,
    sqsRequestsPerRun: 3,
  },
  sources: {
    lambda: "https://aws.amazon.com/lambda/pricing/ (arm64 $0.0000133334 per GB-s, $0.20 per 1M requests; memory 2048 MB and arm64 from Infra/lib/lambda-stack.ts)",
    agentcore: "https://aws.amazon.com/bedrock/agentcore/pricing/ (v1 rates $0.0895/vCPU-h, $0.00945/GB-h; a newer v2 list of $0.1276 and $0.0169 is reported by secondary sources, VERIFY)",
    dynamodb: "https://aws.amazon.com/dynamodb/pricing/on-demand/ ($0.625 per 1M write units, $0.125 per 1M read units)",
    s3: "https://aws.amazon.com/s3/pricing/ (Standard)",
    sqs: "https://aws.amazon.com/sqs/pricing/",
    apiGateway: "https://aws.amazon.com/api-gateway/pricing/ (HTTP API)",
  },
};

function merge<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null || typeof over !== "object" || over === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (typeof cur === "object" && cur !== null) out[k] = merge(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

export function loadAwsRates(env: NodeJS.ProcessEnv = process.env): AwsRates {
  const raw = env.AWS_RATES_JSON;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AWS_RATES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AWS_RATES_JSON is not valid JSON");
  }
  return merge(DEFAULT_AWS_RATES, parsed);
}
