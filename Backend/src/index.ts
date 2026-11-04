import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildServer } from "./api/server.js";
import { S3ArtifactStore } from "./artifacts/s3ArtifactStore.js";
import { loadConfig } from "./config.js";
import { Orchestrator } from "./engine/engine.js";
import { startResumeSweep } from "./engine/sweep.js";
import { withDeadline } from "./shutdown.js";
import { createStrandsModelClient } from "./model/strands.js";
import { createExtractStep } from "./steps/extract.js";
import { createFillLogicStep } from "./steps/fillLogic.js";
import { createIngestStep, defaultExec } from "./steps/ingest.js";
import { acceptAnyObjectValidator } from "./steps/logicModelValidator.js";
import { DynamoStore } from "./store/dynamoStore.js";
import { startQueueConsumer } from "./trigger/queueConsumer.js";

const PRESIGN_EXPIRES_SECONDS = 900;
const SERVER_CLOSE_TIMEOUT_MS = 5000;

const resumeSweepIntervalMs = (leaseMs: number): number => Math.max(1, Math.min(60000, Math.floor(leaseMs / 2)));

// Never log env values, request bodies or message bodies.
const log = (msg: string, detail?: object): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...detail }));
};

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }));
  const store = new DynamoStore(doc, cfg.tables);
  const s3 = new S3Client({ region: cfg.region });
  const artifacts = new S3ArtifactStore(s3, cfg.artifactBucket);
  const model = createStrandsModelClient({ region: cfg.region });

  const orchestrator = new Orchestrator({
    store,
    artifacts,
    model,
    steps: [
      createIngestStep({ pythonBin: cfg.pythonBin, scriptPath: cfg.ingestScript, exec: defaultExec }),
      createExtractStep({ modelId: cfg.modelId, promptPath: cfg.extractPrompt }),
      createFillLogicStep({ validator: acceptAnyObjectValidator }),
    ],
    owner: randomUUID(),
    leaseMs: cfg.leaseMs,
    runnerOpts: {
      maxAttempts: 3,
      backoffMs: (a) => Math.min(30000, 1000 * 2 ** a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      prices: cfg.prices,
    },
  });

  const app = buildServer({
    orchestrator,
    store,
    artifacts,
    validator: acceptAnyObjectValidator,
    presign: (key) =>
      getSignedUrl(s3, new PutObjectCommand({ Bucket: cfg.artifactBucket, Key: key, ContentType: "application/pdf" }), {
        expiresIn: PRESIGN_EXPIRES_SECONDS,
      }),
    // The check steps (validation etc.) will be registered here once they exist.
    onVersionSaved: async (runId, n) => {
      log("version saved", { runId, version: n });
    },
    maxPages: cfg.maxPages,
    logger: false,
  });

  const abort = new AbortController();
  const consumer = startQueueConsumer({
    sqs: new SQSClient({ region: cfg.region }),
    queueUrl: cfg.uploadQueueUrl,
    onUploaded: (runId) => orchestrator.onUploaded(runId),
    signal: abort.signal,
    concurrency: cfg.sqsConcurrency,
    log,
  });

  let stopSweep: (() => void) | undefined;
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("shutting down", { signal });
    abort.abort();
    stopSweep?.();
    const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    // Do not wait for whole pipelines: give in-flight work SHUTDOWN_TIMEOUT_MS, then
    // exit. Interrupted runs keep their lease and the resume sweep of a later
    // process picks them up once it expires.
    void withDeadline(consumer, cfg.shutdownTimeoutMs)
      .then((drained) => {
        if (!drained) log("shutdown deadline reached; in-flight runs left for the resume sweep", { timeoutMs: cfg.shutdownTimeoutMs });
      })
      .catch((e: unknown) => log("shutdown error", { error: errText(e) }))
      .then(() => withDeadline(app.close(), SERVER_CLOSE_TIMEOUT_MS))
      .catch((e: unknown) => log("server close error", { error: errText(e) }))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ host: cfg.host, port: cfg.port });
  log("listening", { host: cfg.host, port: cfg.port });

  try {
    await orchestrator.resumeAll();
  } catch (e) {
    log("resumeAll failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // Runs left by a killed process keep that process's lease until it expires;
  // the sweep picks them up after that.
  if (!stopping) {
    stopSweep = startResumeSweep({
      resumeAll: () => orchestrator.resumeAll(),
      intervalMs: resumeSweepIntervalMs(cfg.leaseMs),
      log,
    });
  }
}

main().catch((e: unknown) => {
  log("startup failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
