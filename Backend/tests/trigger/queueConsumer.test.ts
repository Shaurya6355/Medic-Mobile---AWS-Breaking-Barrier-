import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { startQueueConsumer } from "../../src/trigger/queueConsumer.js";

const sqsMock = mockClient(SQSClient);
const upload = (runId: string) =>
  JSON.stringify({ Records: [{ eventName: "ObjectCreated:Put", s3: { bucket: { name: "b" }, object: { key: `runs/${runId}/input/guideline.pdf` } } }] });
const msg = (id: string, Body: string) => ({ MessageId: id, ReceiptHandle: `rh-${id}`, Body });
const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !pred(); i++) await tick();
  if (!pred()) throw new Error("timeout");
}

// Serve the given batches once each, then empty (after a short pause so the loop does not spin hot).
function serve(...batches: ReturnType<typeof msg>[][]) {
  let i = 0;
  sqsMock.on(ReceiveMessageCommand).callsFake(async () => {
    const b = batches[i++];
    if (b) return { Messages: b };
    await tick();
    return { Messages: [] };
  });
}

const deleted = () => sqsMock.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input.ReceiptHandle);

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(DeleteMessageCommand).resolves({});
});

function start(onUploaded: (id: string) => Promise<void>, extra: Record<string, unknown> = {}) {
  const ac = new AbortController();
  const done = startQueueConsumer({
    sqs: sqsMock as unknown as SQSClient,
    queueUrl: "q",
    onUploaded,
    signal: ac.signal,
    log: () => {},
    ...extra,
  });
  return { ac, done };
}

describe("startQueueConsumer", () => {
  it("calls onUploaded then deletes, passing queue settings", async () => {
    const calls: string[] = [];
    serve([msg("1", upload("r1"))]);
    const { ac, done } = start(async (id) => void calls.push(id), { visibilityTimeoutSeconds: 123, waitTimeSeconds: 7 });
    await waitFor(() => deleted().length === 1);
    ac.abort();
    await done;
    expect(calls).toEqual(["r1"]);
    expect(deleted()).toEqual(["rh-1"]);
    const rc = sqsMock.commandCalls(ReceiveMessageCommand)[0]!.args[0].input;
    expect(rc).toMatchObject({ QueueUrl: "q", VisibilityTimeout: 123, WaitTimeSeconds: 7, MaxNumberOfMessages: 4 });
  });

  it("does not delete when onUploaded throws, and logs no body", async () => {
    const logs: string[] = [];
    serve([msg("1", upload("secret-run"))]);
    let called = 0;
    const { ac, done } = start(async () => { called++; throw new Error("boom"); }, { log: (m: string, d?: object) => logs.push(m + JSON.stringify(d ?? {})) });
    await waitFor(() => called === 1);
    await tick();
    ac.abort();
    await done;
    expect(deleted()).toEqual([]);
    expect(logs.join("\n")).toContain("boom");
    expect(logs.join("\n")).not.toContain("Records");
  });

  it("survives a throwing log function", async () => {
    serve([msg("1", upload("r1"))]);
    let called = 0;
    const { ac, done } = start(async () => { called++; throw new Error("boom"); }, { log: () => { throw new Error("log broke"); } });
    await waitFor(() => called === 1);
    await tick();
    ac.abort();
    await expect(done).resolves.toBeUndefined();
    expect(deleted()).toEqual([]);
  });

  it("does not delete a multi-record message when one run fails", async () => {
    const body = JSON.stringify({ Records: ["a", "b"].map((r) => ({ s3: { bucket: { name: "b" }, object: { key: `runs/${r}/input/guideline.pdf` } } })) });
    serve([msg("1", body)]);
    const seen: string[] = [];
    const { ac, done } = start(async (id) => { seen.push(id); if (id === "b") throw new Error("x"); });
    await waitFor(() => seen.length === 2);
    await tick();
    ac.abort();
    await done;
    expect(deleted()).toEqual([]);
  });

  it("deletes messages that are not ours without calling onUploaded", async () => {
    serve([msg("1", JSON.stringify({ Event: "s3:TestEvent" })), msg("2", "garbage")]);
    let called = 0;
    const { ac, done } = start(async () => void called++);
    await waitFor(() => deleted().length === 2);
    ac.abort();
    await done;
    expect(called).toBe(0);
  });

  it("calls onUploaded twice for a duplicate delivery", async () => {
    const calls: string[] = [];
    serve([msg("1", upload("r1"))], [msg("1", upload("r1"))]);
    const { ac, done } = start(async (id) => void calls.push(id));
    await waitFor(() => deleted().length === 2);
    ac.abort();
    await done;
    expect(calls).toEqual(["r1", "r1"]);
  });

  it("respects concurrency and only polls with free capacity", async () => {
    let active = 0;
    let max = 0;
    let finished = 0;
    const gates: (() => void)[] = [];
    const pending = [1, 2, 3, 4, 5].map((n) => msg(String(n), upload(`r${n}`)));
    sqsMock.on(ReceiveMessageCommand).callsFake(async (input: { MaxNumberOfMessages: number }) => {
      if (pending.length === 0) await tick();
      return { Messages: pending.splice(0, input.MaxNumberOfMessages) };
    });
    const { ac, done } = start(
      async () => {
        active++;
        max = Math.max(max, active);
        await new Promise<void>((r) => gates.push(r));
        active--;
        finished++;
      },
      { concurrency: 2 },
    );
    await waitFor(() => gates.length === 2);
    await tick();
    expect(max).toBe(2);
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(1);
    expect(sqsMock.commandCalls(ReceiveMessageCommand)[0]!.args[0].input.MaxNumberOfMessages).toBe(2);
    while (finished < 5) {
      gates.splice(0).forEach((g) => g());
      await tick();
    }
    ac.abort();
    await done;
    expect(max).toBe(2);
    expect(deleted()).toHaveLength(5);
  });

  it("backs off on receive errors using the injected sleep", async () => {
    const sleeps: number[] = [];
    let n = 0;
    sqsMock.on(ReceiveMessageCommand).callsFake(async () => {
      n++;
      if (n <= 2) throw new Error("net down");
      await tick();
      return { Messages: [] };
    });
    const { ac, done } = start(async () => {}, { sleep: async (ms: number) => void sleeps.push(ms) });
    await waitFor(() => n >= 4);
    ac.abort();
    await done;
    expect(sleeps.slice(0, 2)).toEqual([1000, 1000]);
  });

  it("stops when aborted and waits for in-flight work", async () => {
    let release!: () => void;
    let started = false;
    serve([msg("1", upload("r1"))]);
    const { ac, done } = start(() => { started = true; return new Promise<void>((r) => (release = r)); });
    await waitFor(() => started);
    ac.abort();
    let settled = false;
    void done.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    release();
    await done;
    expect(deleted()).toEqual(["rh-1"]);
  });

  it("resolves immediately if already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await startQueueConsumer({ sqs: sqsMock as unknown as SQSClient, queueUrl: "q", onUploaded: async () => {}, signal: ac.signal });
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });
});
