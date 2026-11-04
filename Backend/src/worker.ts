import type { Queue } from "./queue/queue.ts";
import type { ObjectStore, S3Event } from "./storage/objectStore.ts";
import { extOf, type GuidelineStore, type StepKey } from "./state/guidelines.ts";
import { extract, UnsupportedError } from "./pipeline/extract.ts";
import { digest } from "./pipeline/digest.ts";
import { buildLogicModel, type LogicModelBuilder } from "./pipeline/logicModel.ts";

export interface WorkerDeps {
  queue: Queue;
  store: ObjectStore;
  guidelines: GuidelineStore;
  builder: LogicModelBuilder;
  pollMs: number;
  maxReceives: number;
  log?: (msg: string) => void;
}

/** uploads/<guidelineId>/<file name> */
const UPLOAD_KEY = /^uploads\/([a-z0-9-]+)\/[^/]+$/;

/** Runs the pipeline for one uploaded object. Terminal outcomes are recorded on the guideline, not thrown. */
export async function processUpload(d: WorkerDeps, key: string): Promise<void> {
  const m = UPLOAD_KEY.exec(key);
  if (!m) { d.log?.(`ignoring object outside uploads/: ${key}`); return; }
  const id = m[1];
  const g = d.guidelines.get(id);
  if (!g || g.keys.upload !== key) { d.log?.(`no guideline for ${key}`); return; }
  if (g.status === "Indexed" || g.status === "Unsupported") return; // duplicate event

  let current: StepKey = "event";
  const run = async <T,>(step: StepKey, fn: () => Promise<T>, detail: (v: T) => string): Promise<T> => {
    current = step;
    await d.guidelines.step(id, step, "running");
    const v = await fn();
    await d.guidelines.step(id, step, "done", detail(v));
    return v;
  };

  try {
    await d.guidelines.update(id, r => { r.status = "Processing"; r.error = undefined; });
    await d.guidelines.step(id, "upload", "done", d.store.uri(key));
    await d.guidelines.step(id, "event", "done", "ObjectCreated:Put");

    const body = await d.store.get(key);
    const extracted = await run("extract", () => extract(body, extOf(g.name)), x => `${x.totalPages} page${x.totalPages === 1 ? "" : "s"} via ${x.method}`);
    const extractedKey = `extracted/${id}/pages.json`;
    await d.store.put(extractedKey, JSON.stringify(extracted, null, 2));

    const dg = await run("digest", async () => digest(extracted), x => `${x.stats.blocks} blocks, ${x.stats.decisionBlocks} with decision words, ${x.stats.numbers} numbers with units`);
    const digestedKey = `digested/${id}/digest.json`;
    await d.store.put(digestedKey, JSON.stringify(dg, null, 2));

    const env = await run("logic_model", () => buildLogicModel(d.builder, { guideline: { id, name: g.name }, digest: dg }),
      x => `${x.builder} (${x.source}); ${x.model.questions.length} questions, ${x.model.rules.length} rules; ${x.quoteCheck.found} of ${x.quoteCheck.total} quotes found, ${x.quoteCheck.onPage} on the cited page`);
    const modelKey = `logic-models/${id}/logic-model.json`;
    await d.store.put(modelKey, JSON.stringify(env, null, 2));

    await d.guidelines.update(id, r => {
      r.status = "Indexed";
      r.pages = extracted.totalPages;
      r.blocks = dg.stats.blocks;
      r.keys = { ...r.keys, extracted: extractedKey, digested: digestedKey, logicModel: modelKey };
      r.logicModel = { source: env.source, builder: env.builder, quotesFound: env.quoteCheck.found, quotesTotal: env.quoteCheck.total, quotesOnPage: env.quoteCheck.onPage };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await d.guidelines.step(id, current, "failed", msg);
    await d.guidelines.update(id, r => { r.status = e instanceof UnsupportedError ? "Unsupported" : "Failed"; r.error = msg; });
    d.log?.(`guideline ${id} ${current} failed: ${msg}`);
  }
}

/** Polls the queue like an SQS consumer. Returns a stop function. */
export function startWorker(d: WorkerDeps): () => Promise<void> {
  let stopped = false;
  let busy: Promise<void> = Promise.resolve();
  const tick = async () => {
    for (const msg of await d.queue.receive(5)) {
      try {
        const event = JSON.parse(msg.body) as S3Event;
        for (const rec of event.Records ?? []) {
          if (!rec.eventName?.startsWith("ObjectCreated")) continue;
          await processUpload(d, decodeURIComponent(rec.s3.object.key.replace(/\+/g, " ")));
        }
        await d.queue.delete(msg.id);
      } catch (e) {
        // Unexpected error (not a pipeline outcome): leave the message to reappear, then dead-letter it.
        d.log?.(`message ${msg.id} failed (receive ${msg.receiveCount}): ${e instanceof Error ? e.message : e}`);
        if (msg.receiveCount >= d.maxReceives) await d.queue.deadLetter(msg.id);
      }
    }
  };
  const loop = async () => {
    while (!stopped) {
      busy = tick().catch(e => d.log?.(`worker tick failed: ${e}`));
      await busy;
      await new Promise(r => setTimeout(r, d.pollMs));
    }
  };
  void loop();
  return async () => { stopped = true; await busy; };
}
