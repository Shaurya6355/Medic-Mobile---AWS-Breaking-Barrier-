import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { randomUUID } from "node:crypto";
import { DynamoDBClient, CreateTableCommand, ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoStore, type DynamoTables } from "../../src/store/dynamoStore.js";
import { AlreadyExists, Conflict } from "../../src/store/store.js";
import { runStoreContract } from "./storeContract.js";

const tables: DynamoTables = { runs: "T-runs", steps: "T-steps", versions: "T-versions", comments: "T-comments", audit: "T-audit" };
const ccf = () => new ConditionalCheckFailedException({ message: "c", $metadata: {} });

describe("DynamoStore command shapes", () => {
  const mock = mockClient(DynamoDBDocumentClient);
  const make = () => new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-west-2" })), tables);
  beforeEach(() => mock.reset());

  it("createRun puts with attribute_not_exists and maps failure to AlreadyExists", async () => {
    mock.on(PutCommand).resolves({});
    await make().createRun({ runId: "r1", state: "created", createdAt: 1 });
    const input = mock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.TableName).toBe("T-runs");
    expect(input.Item).toMatchObject({ runId: "r1", state: "created" });
    expect(input.ConditionExpression).toBe("attribute_not_exists(runId)");
    mock.on(PutCommand).rejects(ccf());
    await expect(make().createRun({ runId: "r1", state: "created", createdAt: 1 })).rejects.toBeInstanceOf(AlreadyExists);
  });

  it("updateRun conditions on existence and expectedState; failure on live run is Conflict", async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { runId: "r1", state: "ingesting", createdAt: 1 } });
    const r = await make().updateRun("r1", { state: "ingesting" }, "created");
    expect(r.state).toBe("ingesting");
    const input = mock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe("T-runs");
    expect(input.Key).toEqual({ runId: "r1" });
    expect(input.ConditionExpression).toContain("attribute_exists(runId)");
    expect(input.ConditionExpression).toContain("#state = :expectedState");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":expectedState": "created" });
    expect(input.ReturnValues).toBe("ALL_NEW");
    mock.on(UpdateCommand).rejects(ccf());
    mock.on(GetCommand).resolves({ Item: { runId: "r1", state: "failed", createdAt: 1 } });
    await expect(make().updateRun("r1", { state: "x" as never }, "created")).rejects.toBeInstanceOf(Conflict);
    mock.on(GetCommand).resolves({});
    await expect(make().updateRun("r1", { state: "failed" }, "created")).rejects.not.toBeInstanceOf(Conflict);
  });

  it("addVersion writes version and latest pointer in one transaction with a chain condition", async () => {
    mock.on(TransactWriteCommand).resolves({});
    await make().addVersion({ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: "k" });
    let items = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    const vPut = items.find((i) => i.Put?.Item?.["n"] === 1)!.Put!;
    expect(vPut.TableName).toBe("T-versions");
    expect(vPut.ConditionExpression).toBe("attribute_not_exists(runId)");
    const latest1 = items.find((i) => i.Put?.Item?.["n"] === 0)!.Put!;
    expect(latest1.ConditionExpression).toBe("attribute_not_exists(runId)");
    expect(latest1.Item).toMatchObject({ runId: "r1", n: 0, latest: 1 });

    mock.reset();
    mock.on(TransactWriteCommand).resolves({});
    await make().addVersion({ runId: "r1", n: 2, parent: 1, author: "u", createdAt: 1, artifactKey: "k" });
    items = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const upd = items.find((i) => i.Update)!.Update!;
    expect(upd.Key).toEqual({ runId: "r1", n: 0 });
    expect(upd.ConditionExpression).toContain("#latest = :parent");
    expect(upd.ExpressionAttributeValues).toMatchObject({ ":parent": 1, ":n": 2 });
  });

  it("addSignature checks the latest pointer and conditions the version update (officer, then clinician)", async () => {
    const sig = { runId: "r1", n: 2, modelSha: "a".repeat(64), role: "program_officer" as const, userId: "o1", signedAt: 10 };
    mock.on(TransactWriteCommand).resolves({});
    mock.on(GetCommand).resolves({ Item: { runId: "r1", n: 2, parent: 1, author: "u", createdAt: 1, artifactKey: "k", signatures: [sig] } });
    const v = await make().addSignature(sig);
    expect(v.signatures).toEqual([sig]);
    let items = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    const check = items[0]!.ConditionCheck!;
    expect(check).toMatchObject({ TableName: "T-versions", Key: { runId: "r1", n: 0 }, ConditionExpression: "#latest = :n" });
    expect(check.ExpressionAttributeValues).toEqual({ ":n": 2 });
    let upd = items[1]!.Update!;
    expect(upd.Key).toEqual({ runId: "r1", n: 2 });
    expect(upd.UpdateExpression).toBe("SET #sigs = :one");
    expect(upd.ConditionExpression).toContain("attribute_not_exists(#sigs) OR size(#sigs) = :zero");
    expect(upd.ConditionExpression).toContain("#status <> :locked");

    mock.reset();
    mock.on(TransactWriteCommand).resolves({});
    mock.on(GetCommand).resolves({ Item: { runId: "r1", n: 2 } });
    await make().addSignature({ ...sig, role: "clinician", userId: "c1", signedAt: 20 });
    items = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    upd = items[1]!.Update!;
    expect(upd.UpdateExpression).toBe("SET #sigs = list_append(#sigs, :one), #status = :locked, #lockedAt = :at");
    expect(upd.ConditionExpression).toContain("#sigs[0].#role = :officer AND #sigs[0].#sha = :sha AND #sigs[0].#user <> :user");
    expect(upd.ExpressionAttributeValues).toMatchObject({ ":sha": "a".repeat(64), ":user": "c1", ":at": 20, ":count": 1 });

    mock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "c", $metadata: {}, CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] }));
    await expect(make().addSignature(sig)).rejects.toBeInstanceOf(Conflict);
  });

  it("addSignature normalises the userId, binds the clinician to the officer's settingsSha and refuses rejected versions (DEC-020)", async () => {
    const sig = { runId: "r1", n: 2, modelSha: "a".repeat(64), role: "clinician" as const, userId: " Clinician\u200b", signedAt: 20, settingsSha: "5".repeat(64) };
    mock.on(TransactWriteCommand).resolves({});
    mock.on(GetCommand).resolves({ Item: { runId: "r1", n: 2 } });
    await make().addSignature(sig);
    const upd = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![1]!.Update!;
    expect(upd.ExpressionAttributeValues).toMatchObject({ ":user": "clinician", ":set": "5".repeat(64), ":rejected": "rejected" });
    expect(upd.ConditionExpression).toContain("#sigs[0].#set = :set");
    expect(upd.ConditionExpression).toContain("#status <> :rejected");
    expect((upd.ExpressionAttributeValues as Record<string, { userId: string }[]>)[":one"]![0]!.userId).toBe("clinician");
    await expect(make().addSignature({ ...sig, userId: "\u200b " })).rejects.toBeInstanceOf(Conflict);
  });

  it("rejectVersion checks the latest pointer and conditions on the officer signature (AR-06)", async () => {
    mock.on(TransactWriteCommand).resolves({});
    mock.on(GetCommand).resolves({ Item: { runId: "r1", n: 2, status: "rejected" } });
    const rej = { role: "clinician" as const, userId: "Doc", modelSha: "a".repeat(64), comment: "R3 must refer urgently.", urgent: true, rejectedAt: 30 };
    const v = await make().rejectVersion("r1", 2, rej);
    expect(v.status).toBe("rejected");
    const items = mock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]!.ConditionCheck).toMatchObject({ Key: { runId: "r1", n: 0 }, ConditionExpression: "#latest = :n" });
    const upd = items[1]!.Update!;
    expect(upd.UpdateExpression).toBe("SET #status = :rejected, #rej = :rej");
    expect(upd.ConditionExpression).toContain("#sigs[0].#role = :officer AND #sigs[0].#sha = :sha AND #sigs[0].#user <> :user");
    expect(upd.ExpressionAttributeValues).toMatchObject({ ":user": "doc", ":sha": "a".repeat(64) });
    mock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "c", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }));
    await expect(make().rejectVersion("r1", 2, rej)).rejects.toBeInstanceOf(Conflict);
  });

  it("updateRun and updateStep turn undefined values into REMOVE clauses", async () => {
    mock.on(UpdateCommand).resolves({ Attributes: { runId: "r1", state: "created", createdAt: 1 } });
    await make().updateRun("r1", { lease: undefined, state: "ingesting" });
    const run = mock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(run.UpdateExpression).toMatch(/^SET #f\d = :f\d REMOVE #f\d$/);
    const removed = /REMOVE (#f\d)/.exec(run.UpdateExpression!)![1]!;
    expect(run.ExpressionAttributeNames![removed]).toBe("lease");
    expect(Object.keys(run.ExpressionAttributeValues ?? {})).toHaveLength(1);
    await make().updateStep("r1", "x", 1, { error: undefined });
    const st = mock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(st.UpdateExpression).toMatch(/^REMOVE #f0$/);
    expect(st.ExpressionAttributeNames).toEqual({ "#f0": "error" });
    expect(st.ExpressionAttributeValues).toBeUndefined();
  });

  it("addVersion rethrows cancellations that are not chain conflicts", async () => {
    const v = { runId: "r1", n: 2, parent: 1, author: "u", createdAt: 1, artifactKey: "k" };
    mock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "t", $metadata: {}, CancellationReasons: [{ Code: "ThrottlingError" }, { Code: "None" }] }));
    const err = await make().addVersion(v).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(Conflict);
    expect((err as Error).name).toBe("TransactionCanceledException");
    mock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "t", $metadata: {}, CancellationReasons: [{ Code: "TransactionConflict" }] }));
    await expect(make().addVersion(v)).rejects.toBeInstanceOf(Conflict);
  });

  it("addVersion maps cancelled transaction to Conflict and rejects bad chain locally", async () => {
    mock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "c", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }));
    await expect(make().addVersion({ runId: "r1", n: 2, parent: 1, author: "u", createdAt: 1, artifactKey: "k" })).rejects.toBeInstanceOf(Conflict);
    mock.reset();
    await expect(make().addVersion({ runId: "r1", n: 3, parent: 1, author: "u", createdAt: 1, artifactKey: "k" })).rejects.toBeInstanceOf(Conflict);
    await expect(make().addVersion({ runId: "r1", n: 1, parent: 5, author: "u", createdAt: 1, artifactKey: "k" })).rejects.toBeInstanceOf(Conflict);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("listVersions queries n >= 1 so the latest pointer is excluded", async () => {
    mock.on(QueryCommand).resolves({ Items: [{ runId: "r1", n: 1, parent: null, author: "ai", createdAt: 1, artifactKey: "k" }] });
    const vs = await make().listVersions("r1");
    expect(vs).toHaveLength(1);
    const input = mock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.TableName).toBe("T-versions");
    expect(input.KeyConditionExpression).toContain("#n >= :one");
  });

  it("acquireLease is a conditional update: free, expired, or same owner", async () => {
    mock.on(UpdateCommand).resolves({});
    expect(await make().acquireLease("r1", "a", 100, 1000)).toBe(true);
    const input = mock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe("T-runs");
    expect(input.ConditionExpression).toContain("attribute_exists(runId)");
    expect(input.ConditionExpression).toContain("attribute_not_exists(#lease)");
    expect(input.ConditionExpression).toContain("#lease.expiresAt <= :now");
    expect(input.ConditionExpression).toContain("#lease.#owner = :owner");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":now": 1000, ":owner": "a", ":lease": { owner: "a", expiresAt: 1100 } });
    mock.on(UpdateCommand).rejects(ccf());
    mock.on(GetCommand).resolves({ Item: { runId: "r1", state: "created", createdAt: 1 } });
    expect(await make().acquireLease("r1", "b", 100, 1000)).toBe(false);
    mock.on(GetCommand).resolves({});
    await expect(make().acquireLease("r1", "b", 100, 1000)).rejects.toThrow(/not found/i);
  });

  it("releaseLease removes the lease only for its owner and ignores condition failures", async () => {
    mock.on(UpdateCommand).resolves({});
    await make().releaseLease("r1", "a");
    const input = mock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe("T-runs");
    expect(input.Key).toEqual({ runId: "r1" });
    expect(input.UpdateExpression).toBe("REMOVE #lease");
    expect(input.ConditionExpression).toBe("#lease.#owner = :owner");
    expect(input.ExpressionAttributeNames).toEqual({ "#lease": "lease", "#owner": "owner" });
    expect(input.ExpressionAttributeValues).toEqual({ ":owner": "a" });
    mock.on(UpdateCommand).rejects(ccf());
    await expect(make().releaseLease("r1", "b")).resolves.toBeUndefined();
    mock.on(UpdateCommand).rejects(new Error("network"));
    await expect(make().releaseLease("r1", "a")).rejects.toThrow("network");
  });

  it("appendAudit puts with a unique, ordered sort key and a not-exists condition", async () => {
    mock.on(PutCommand).resolves({});
    const s = make();
    await s.appendAudit("r1", { at: 5, type: "a", detail: 1 });
    await s.appendAudit("r1", { at: 5, type: "b", detail: 2 });
    const [a, b] = mock.commandCalls(PutCommand).map((c) => c.args[0].input);
    expect(a!.TableName).toBe("T-audit");
    expect(a!.ConditionExpression).toBe("attribute_not_exists(sk)");
    const ska = a!.Item!["sk"] as string;
    const skb = b!.Item!["sk"] as string;
    expect(ska).not.toBe(skb);
    expect(ska < skb).toBe(true);
  });

  it("appendStep and addComment use their own tables; listComments filters by version prefix", async () => {
    mock.on(PutCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    const s = make();
    await s.appendStep({ runId: "r1", step: "x", attempt: 1, status: "running", startedAt: 1, inputTokens: 0, outputTokens: 0, artifactRefs: {} });
    await s.addComment({ runId: "r1", n: 1, itemRef: "a", author: "u", text: "t", createdAt: 1 });
    const puts = mock.commandCalls(PutCommand).map((c) => c.args[0].input.TableName);
    expect(puts).toEqual(["T-steps", "T-comments"]);
    await s.listComments("r1", 1);
    expect(mock.commandCalls(QueryCommand)[0]!.args[0].input.KeyConditionExpression).toContain("begins_with");
  });

  it("listResumable scans runs with a state/lease filter and follows pagination", async () => {
    mock.on(ScanCommand)
      .resolvesOnce({ Items: [{ runId: "a", state: "checking", createdAt: 1 }], LastEvaluatedKey: { runId: "a" } })
      .resolvesOnce({ Items: [{ runId: "b", state: "checking", createdAt: 2 }] });
    const out = await make().listResumable(1000);
    expect(out.map((r) => r.runId)).toEqual(["a", "b"]);
    const input = mock.commandCalls(ScanCommand)[0]!.args[0].input;
    expect(input.FilterExpression).toContain("#state IN");
    expect(input.FilterExpression).toContain("#lease.expiresAt <= :now");
  });
});

const endpoint = process.env["DYNAMODB_ENDPOINT"];
describe.skipIf(!endpoint)("DynamoStore against DynamoDB Local (DYNAMODB_ENDPOINT)", () => {
  runStoreContract("DynamoStore", async () => {
    const raw = new DynamoDBClient({
      region: "us-west-2",
      endpoint,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const prefix = `t${randomUUID().replace(/-/g, "")}`;
    const names: DynamoTables = {
      runs: `${prefix}-runs`, steps: `${prefix}-steps`, versions: `${prefix}-versions`,
      comments: `${prefix}-comments`, audit: `${prefix}-audit`,
    };
    const mk = (TableName: string, hash: string, range?: { name: string; type: "S" | "N" }) =>
      raw.send(new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: hash, AttributeType: "S" },
          ...(range ? [{ AttributeName: range.name, AttributeType: range.type }] : []),
        ],
        KeySchema: [
          { AttributeName: hash, KeyType: "HASH" },
          ...(range ? [{ AttributeName: range.name, KeyType: "RANGE" as const }] : []),
        ],
      }));
    await Promise.all([
      mk(names.runs, "runId"),
      mk(names.steps, "runId", { name: "sk", type: "S" }),
      mk(names.versions, "runId", { name: "n", type: "N" }),
      mk(names.comments, "runId", { name: "sk", type: "S" }),
      mk(names.audit, "runId", { name: "sk", type: "S" }),
    ]);
    return new DynamoStore(DynamoDBDocumentClient.from(raw), names);
  });
});
