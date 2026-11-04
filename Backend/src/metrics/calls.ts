import { usageOf } from "../engine/step.js";
import type { CallRecord } from "../domain/types.js";
import type { ModelClient } from "../model/modelClient.js";

export interface InstrumentOptions {
  now(): number;
  backend: CallRecord["backend"];
  // Receives one record per generateJson call, appended in call order.
  sink: CallRecord[];
}

const MAX_CALL_ERROR_CHARS = 300;

// Wraps a ModelClient so every call (the request, the response and how long it took) is recorded.
// Request and response content is never stored: only timing, token counts and the error text.
export function instrumentModel(inner: ModelClient, opts: InstrumentOptions): ModelClient {
  return {
    async generateJson(req) {
      const startedAt = opts.now();
      const base = { seq: opts.sink.length + 1, backend: opts.backend, modelId: req.modelId, startedAt };
      try {
        const res = await inner.generateJson(req);
        const endedAt = opts.now();
        opts.sink.push({
          ...base,
          endedAt,
          latencyMs: endedAt - startedAt,
          status: "succeeded",
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          modelId: res.usage.modelId || req.modelId,
        });
        return res;
      } catch (e) {
        const endedAt = opts.now();
        const usage = usageOf(e);
        opts.sink.push({
          ...base,
          endedAt,
          latencyMs: endedAt - startedAt,
          status: "failed",
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          error: (e instanceof Error ? e.message : String(e)).slice(0, MAX_CALL_ERROR_CHARS),
        });
        throw e;
      }
    },
  };
}
