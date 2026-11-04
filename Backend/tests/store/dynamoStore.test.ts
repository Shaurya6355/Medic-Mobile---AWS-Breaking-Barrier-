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
