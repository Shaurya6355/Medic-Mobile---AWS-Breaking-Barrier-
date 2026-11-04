import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrices, type PriceTable } from "./metrics/cost.js";

export interface Config {
  region: string;
  port: number;
  host: string;
  tables: { runs: string; steps: string; versions: string; comments: string; audit: string };
  artifactBucket: string;
  runMode: "container" | "agentcore" | "lambda";
  // Absent in agentcore and lambda modes: a trigger outside the process calls /invocations instead.
  uploadQueueUrl?: string;
  modelId: string;
  // bedrock: Strands runs in this process; agentcore: it runs on an AgentCore Runtime (AgentService).
  modelBackend: "bedrock" | "agentcore";
  agentCoreRuntimeArn?: string;
  leaseMs: number;
  maxPages: number;
  // Largest input PDF ingest will download, in bytes.
  maxPdfBytes: number;
  sqsConcurrency: number;
  shutdownTimeoutMs: number;
  pythonBin: string;
  ingestScript: string;
  extractPrompt: string;
  fillPrompt: string;
  // Model for the fill_logic draft; defaults to MODEL_ID (the IAM policy covers MODEL_ID only).
  fillModelId: string;
  prices: PriceTable;
}

const REQUIRED = [
  "TABLE_RUNS",
  "TABLE_STEPS",
  "TABLE_VERSIONS",
  "TABLE_COMMENTS",
  "TABLE_AUDIT",
  "ARTIFACT_BUCKET",
  "MODEL_ID",
] as const;

// This file is src/config.ts or dist/config.js; extraction/ sits next to both.
const here = path.dirname(fileURLToPath(import.meta.url));
const extractionDir = path.resolve(here, "..", "extraction");

function positiveInt(env: NodeJS.ProcessEnv, name: string, dflt: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ""}`);
  return n;
}

const str = (env: NodeJS.ProcessEnv, name: string, dflt: string): string => {
  const v = env[name];
  return v === undefined || v === "" ? dflt : v;
};

// Lambda invocations last at most 15 minutes (900000 ms); a lease at or below that could be
// taken over while the invocation is still alive.
const LAMBDA_MIN_LEASE_MS = 900000;

function leaseMs(env: NodeJS.ProcessEnv, runMode: Config["runMode"]): number {
  if (runMode !== "lambda") return positiveInt(env, "LEASE_MS", 900000);
  const n = positiveInt(env, "LEASE_MS", 960000);
  if (n <= LAMBDA_MIN_LEASE_MS) throw new Error(`LEASE_MS must be above ${LAMBDA_MIN_LEASE_MS} in lambda mode (the 15 minute Lambda timeout); use 960000`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const rawMode = str(env, "RUN_MODE", "container");
  if (rawMode !== "container" && rawMode !== "agentcore" && rawMode !== "lambda") {
    throw new Error("RUN_MODE must be one of: container, agentcore, lambda");
  }
  const runMode = rawMode;
  const rawBackend = str(env, "MODEL_BACKEND", "bedrock");
  if (rawBackend !== "bedrock" && rawBackend !== "agentcore") {
    throw new Error("MODEL_BACKEND must be one of: bedrock, agentcore");
  }
  const modelBackend = rawBackend;
  const required: readonly string[] = runMode === "container" ? [...REQUIRED, "UPLOAD_QUEUE_URL"] : REQUIRED;
  const missing = required.filter((n) => env[n] === undefined || env[n] === "");
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  let agentCoreRuntimeArn: string | undefined;
  if (modelBackend === "agentcore") {
    agentCoreRuntimeArn = env["AGENTCORE_RUNTIME_ARN"];
    if (agentCoreRuntimeArn === undefined || agentCoreRuntimeArn === "") {
      throw new Error("AGENTCORE_RUNTIME_ARN is required when MODEL_BACKEND=agentcore");
    }
    if (!/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/.+/.test(agentCoreRuntimeArn)) {
      throw new Error("AGENTCORE_RUNTIME_ARN must be a bedrock-agentcore runtime ARN");
    }
  }
  const req = (n: (typeof REQUIRED)[number]): string => env[n] as string;
  return {
    region: str(env, "AWS_REGION", "us-west-2"),
    port: positiveInt(env, "PORT", 8080, 65535),
    host: str(env, "HOST", "0.0.0.0"),
    tables: {
      runs: req("TABLE_RUNS"),
      steps: req("TABLE_STEPS"),
      versions: req("TABLE_VERSIONS"),
      comments: req("TABLE_COMMENTS"),
      audit: req("TABLE_AUDIT"),
    },
    artifactBucket: req("ARTIFACT_BUCKET"),
    runMode,
    ...(runMode === "container" ? { uploadQueueUrl: env["UPLOAD_QUEUE_URL"] as string } : {}),
    modelId: req("MODEL_ID"),
    modelBackend,
    ...(agentCoreRuntimeArn !== undefined ? { agentCoreRuntimeArn } : {}),
    leaseMs: leaseMs(env, runMode),
    maxPages: positiveInt(env, "MAX_PAGES", 200),
    maxPdfBytes: positiveInt(env, "MAX_PDF_BYTES", 52428800),
    sqsConcurrency: positiveInt(env, "SQS_CONCURRENCY", 4),
    shutdownTimeoutMs: positiveInt(env, "SHUTDOWN_TIMEOUT_MS", 25000),
    pythonBin: str(env, "PYTHON_BIN", "python3"),
    ingestScript: str(env, "INGEST_SCRIPT", path.join(extractionDir, "prepare_input.py")),
    extractPrompt: str(env, "EXTRACT_PROMPT", path.join(extractionDir, "final_prompt.txt")),
    fillPrompt: str(env, "FILL_PROMPT", path.join(extractionDir, "fill_prompt.txt")),
    fillModelId: str(env, "FILL_MODEL_ID", req("MODEL_ID")),
    prices: loadPrices(env),
  };
}
