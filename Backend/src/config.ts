import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrices, type PriceTable } from "./metrics/cost.js";

export interface Config {
  region: string;
  port: number;
  host: string;
  tables: { runs: string; steps: string; versions: string; comments: string; audit: string };
  artifactBucket: string;
  uploadQueueUrl: string;
  modelId: string;
  leaseMs: number;
  maxPages: number;
  sqsConcurrency: number;
  pythonBin: string;
  ingestScript: string;
  extractPrompt: string;
  prices: PriceTable;
}

const REQUIRED = [
  "TABLE_RUNS",
  "TABLE_STEPS",
  "TABLE_VERSIONS",
  "TABLE_COMMENTS",
  "TABLE_AUDIT",
  "ARTIFACT_BUCKET",
  "UPLOAD_QUEUE_URL",
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((n) => env[n] === undefined || env[n] === "");
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
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
    uploadQueueUrl: req("UPLOAD_QUEUE_URL"),
    modelId: req("MODEL_ID"),
    leaseMs: positiveInt(env, "LEASE_MS", 900000),
    maxPages: positiveInt(env, "MAX_PAGES", 200),
    sqsConcurrency: positiveInt(env, "SQS_CONCURRENCY", 4),
    pythonBin: str(env, "PYTHON_BIN", "python3"),
    ingestScript: str(env, "INGEST_SCRIPT", path.join(extractionDir, "prepare_input.py")),
    extractPrompt: str(env, "EXTRACT_PROMPT", path.join(extractionDir, "final_prompt.txt")),
    prices: loadPrices(env),
  };
}
