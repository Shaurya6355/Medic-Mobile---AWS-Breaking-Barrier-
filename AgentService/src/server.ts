import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { BadRequestError, isTransientBedrockError, runAgent, type AgentFactory } from "./agent.js";
import { MAX_BODY_BYTES, MAX_FAILURE_MESSAGE, invocationRequestSchema, type InvocationFailure, type PingResponse } from "./contract.js";

export const DEFAULT_BODY_LIMIT_BYTES = MAX_BODY_BYTES;

export interface ServerDeps {
  createAgent: AgentFactory;
  region?: string;
  bodyLimitBytes?: number;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : "unknown error";
  return m.slice(0, MAX_FAILURE_MESSAGE);
}

const failure = (kind: InvocationFailure["kind"], message: string): InvocationFailure => ({
  ok: false,
  kind,
  message: message.slice(0, MAX_FAILURE_MESSAGE),
});

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: deps.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES, logger: false });
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  let inFlight = 0;
  let lastStatus: PingResponse["status"] = "Healthy";
  let lastChange: number | undefined;
  const current = (): PingResponse["status"] => (inFlight > 0 ? "HealthyBusy" : "Healthy");
  const refresh = (): void => {
    const s = current();
    if (s !== lastStatus) {
      lastStatus = s;
      lastChange = now();
    }
  };

  // Always HTTP 200 with an envelope (see contract.ts). Framework-level errors (malformed JSON,
  // body too large, ...) are invalid_request; anything else is permanent. Never echo the request.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status === 413) return reply.code(200).send(failure("invalid_request", "request body too large (over the body limit)"));
    if (status >= 400 && status < 500) return reply.code(200).send(failure("invalid_request", `malformed request (${err.code ?? status})`));
    return reply.code(200).send(failure("permanent", "internal error"));
  });

  app.get("/ping", async () => {
    refresh();
    const out: PingResponse = { status: lastStatus };
    if (lastChange !== undefined) out.time_of_last_update = lastChange;
    return out;
  });

  app.post("/invocations", async (req, reply) => {
    const parsed = invocationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Paths and codes only: never the offending values.
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
      return reply.code(200).send(failure("invalid_request", `request failed validation at ${issues.join(", ")}`));
    }
    inFlight++;
    refresh();
    try {
      const out = await runAgent(parsed.data, { createAgent: deps.createAgent, region: deps.region });
      return reply.code(200).send(out);
    } catch (e) {
      if (e instanceof BadRequestError) return reply.code(200).send(failure("invalid_request", e.message));
      if (isTransientBedrockError(e)) return reply.code(200).send(failure("transient", safeMessage(e)));
      return reply.code(200).send(failure("permanent", safeMessage(e)));
    } finally {
      inFlight--;
      refresh();
    }
  });

  return app;
}
