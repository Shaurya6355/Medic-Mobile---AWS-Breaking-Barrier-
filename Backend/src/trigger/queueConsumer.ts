import { DeleteMessageCommand, ReceiveMessageCommand, type Message, type SQSClient } from "@aws-sdk/client-sqs";
import { parseS3Event } from "./s3Event.js";

export interface QueueConsumerOptions {
  sqs: SQSClient;
  queueUrl: string;
  onUploaded: (runId: string) => Promise<void>;
  signal: AbortSignal;
  concurrency?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
  log?: (msg: string, detail?: object) => void;
  // Injectable for tests.
  sleep?: (ms: number) => Promise<void>;
}

const RECEIVE_ERROR_BACKOFF_MS = 1000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Long-polls the queue until the signal aborts, then waits for in-flight work to settle.
// A message is deleted only after every onUploaded call for it resolved; on failure it stays
// on the queue and SQS redelivers it (the engine makes the repeat a no-op).
export async function startQueueConsumer(opts: QueueConsumerOptions): Promise<void> {
  const { sqs, queueUrl, onUploaded, signal } = opts;
  const concurrency = opts.concurrency ?? 4;
  const visibility = opts.visibilityTimeoutSeconds ?? 900;
  const wait = opts.waitTimeSeconds ?? 20;
  const userLog = opts.log ?? (() => {});
  // A throwing caller-supplied logger must never reject an in-flight promise.
  const log = (msg: string, detail?: object): void => {
    try {
      userLog(msg, detail);
    } catch {
      // ignore
    }
  };
  const sleep = opts.sleep ?? defaultSleep;
  const inFlight = new Set<Promise<void>>();

  const handle = async (m: Message): Promise<void> => {
    try {
      const runIds = [...new Set(parseS3Event(m.Body ?? "").map((o) => o.runId))];
      for (const runId of runIds) {
        try {
          await onUploaded(runId);
        } catch (e) {
          log("onUploaded failed; message left for redelivery", { runId, error: errText(e) });
          return;
        }
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    } catch (e) {
      log("message handling failed", { error: errText(e) });
    }
  };

  while (!signal.aborted) {
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
      continue;
    }
    let messages: Message[];
    try {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(10, concurrency - inFlight.size),
          VisibilityTimeout: visibility,
          WaitTimeSeconds: wait,
        }),
        { abortSignal: signal },
      );
      messages = res.Messages ?? [];
    } catch (e) {
      if (signal.aborted) break;
      log("receive failed", { error: errText(e) });
      await sleep(RECEIVE_ERROR_BACKOFF_MS);
      continue;
    }
    for (const m of messages) {
      const p: Promise<void> = handle(m).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
  }
  await Promise.allSettled([...inFlight]);
}
