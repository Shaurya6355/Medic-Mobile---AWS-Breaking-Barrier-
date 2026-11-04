import { InvokeCommand } from "@aws-sdk/client-lambda";

/** One unit of background work: run step 2 of a confirmed revision. */
export interface RevisionJob {
  runId: string;
  revisionId: string;
}

/**
 * Starts step 2 of a revision OUTSIDE the HTTP request (API Gateway cuts a request at 30 s, Bedrock can take
 * longer). dispatch() returns as soon as the work is handed over; it rejects only if the hand-over failed.
 */
export interface RevisionDispatcher {
  dispatch(job: RevisionJob): Promise<void>;
}

/** Payload of the asynchronous self-invoke; the Lambda Web Adapter forwards it to POST /events. */
export const REVISION_EVENT_SOURCE = "revision";

/**
 * Container and agentcore modes: the process stays alive after the response, so the work simply runs on.
 * The in-flight set lets graceful shutdown and tests wait for it (drain()).
 */
export class InProcessDispatcher implements RevisionDispatcher {
  private readonly inFlight = new Set<Promise<void>>();

  /** `run` should not throw (RevisionService.runApply records its own failures); `onError` is the last resort. */
  constructor(
    private readonly run: (job: RevisionJob) => Promise<void>,
    private readonly onError: (job: RevisionJob, e: unknown) => void = () => {},
  ) {}

  dispatch(job: RevisionJob): Promise<void> {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(job))
      .catch((e: unknown) => {
        try {
          this.onError(job, e);
        } catch {
          // Nothing more to do.
        }
      })
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
    return Promise.resolve();
  }

  size(): number {
    return this.inFlight.size;
  }

  /** Resolves when every job dispatched so far (and any dispatched meanwhile) has finished. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }
}

/** The part of LambdaClient used here, so tests need no AWS SDK mock. */
export interface LambdaInvoker {
  send(command: InvokeCommand): Promise<{ StatusCode?: number; FunctionError?: string }>;
}

/**
 * Lambda mode: the process is frozen once the response is sent, so background work in the same invocation
 * is impossible. The function invokes ITSELF asynchronously (InvocationType "Event"); the Lambda Web Adapter
 * hands the payload to POST /events, which calls RevisionService.runApply and waits for it.
 * Needs lambda:InvokeFunction on the function's own ARN.
 */
export class LambdaAsyncDispatcher implements RevisionDispatcher {
  constructor(
    private readonly client: LambdaInvoker,
    private readonly functionName: string,
  ) {}

  async dispatch(job: RevisionJob): Promise<void> {
    const payload = JSON.stringify({ source: REVISION_EVENT_SOURCE, runId: job.runId, revisionId: job.revisionId });
    const res = await this.client.send(new InvokeCommand({ FunctionName: this.functionName, InvocationType: "Event", Payload: new TextEncoder().encode(payload) }));
    // An asynchronous invoke answers 202 when the event is queued.
    if (res.StatusCode !== 202) throw new Error(`Lambda async invoke answered ${String(res.StatusCode)}`);
  }
}
