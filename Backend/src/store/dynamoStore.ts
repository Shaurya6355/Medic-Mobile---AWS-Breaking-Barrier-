import { randomUUID } from "node:crypto";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { RunState } from "../contract/schemas.js";
import type { Comment, Rejection, Run, Signature, StepRecord, Version } from "../domain/types.js";
import { InvalidUserId, normaliseUserId } from "../signoff/identity.js";
import { AlreadyExists, Conflict } from "./store.js";
import type { AuditEvent, Store } from "./store.js";

/*
 * Table key layout (table names come from the constructor, never literals).
 *
 *   runs      HASH runId (S).            One item per run; the Run fields are top-level
 *                                        attributes, lease is a map {owner, expiresAt}.
 *   steps     HASH runId, RANGE sk (S).  sk = "<step>#<attempt padded to 6>".
 *   versions  HASH runId, RANGE n (N).   n >= 1: the version items. Their body pointer (artifactKey) is
 *                                        never rewritten; the only updates are addSignature, which appends
 *                                        to `signatures` and sets `status`/`lockedAt` under a condition,
 *                                        and rejectVersion, which sets `status` "rejected" and
 *                                        `rejection` under a condition (AR-06).
 *                                        n = 0: the per-run "latest pointer" item
 *                                        {runId, n: 0, latest: <number>}. addVersion writes
 *                                        the version and moves the pointer in one transaction,
 *                                        conditioned on the pointer still equal to the parent
 *                                        (or absent for n = 1), so concurrent saves conflict.
 *   comments  HASH runId, RANGE sk (S).  sk = "<n padded 10>#<createdAt padded 15>#<uuid>".
 *   audit     HASH runId, RANGE sk (S).  sk = "<at padded 15>#<process counter padded 10>#<uuid>":
 *                                        ordered by time, then by append order within this
 *                                        process, and unique across processes via the uuid.
 *                                        Append-only: only Put (with attribute_not_exists(sk))
 *                                        and Query are ever issued against this table.
 */

export interface DynamoTables {
  runs: string;
  steps: string;
  versions: string;
  comments: string;
  audit: string;
}

const WORK_STATES: readonly RunState[] = ["ingesting", "extracting", "filling_logic", "checking"];

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

// Drops undefined values (DynamoDB cannot store them) without touching null.
const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const stripKeys = <T>(item: Record<string, unknown>, ...keys: string[]): T => {
  const copy = { ...item };
  for (const k of keys) delete copy[k];
  return copy as T;
};

const isConditionFailure = (e: unknown): boolean => e instanceof Error && e.name === "ConditionalCheckFailedException";

const isChainConflict = (e: unknown): boolean => {
  if (!(e instanceof Error) || e.name !== "TransactionCanceledException") return false;
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict");
};

// SET for defined values, REMOVE for keys explicitly set to undefined.
function buildUpdate(patch: Record<string, unknown>, skip: readonly string[]): {
  UpdateExpression?: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  Object.entries(patch)
    .filter(([k]) => !skip.includes(k))
    .forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      if (v === undefined) {
        removes.push(`#f${i}`);
      } else {
        values[`:f${i}`] = clean({ v }).v;
        sets.push(`#f${i} = :f${i}`);
      }
    });
  const parts = [sets.length > 0 ? `SET ${sets.join(", ")}` : "", removes.length > 0 ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean);
  return { UpdateExpression: parts.length > 0 ? parts.join(" ") : undefined, names, values };
}

export class DynamoStore implements Store {
  private auditSeq = 0;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tables: DynamoTables,
  ) {}

  private async scanAll(input: ConstructorParameters<typeof ScanCommand>[0]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new ScanCommand({ ...input, ExclusiveStartKey: key }));
      out.push(...((res.Items ?? []) as Record<string, unknown>[]));
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  }

  private async queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
      out.push(...((res.Items ?? []) as Record<string, unknown>[]));
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  }

  async createRun(run: Run): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.runs,
          Item: clean(run),
          ConditionExpression: "attribute_not_exists(runId)",
        }),
      );
    } catch (e) {
      if (isConditionFailure(e)) throw new AlreadyExists(`Run exists: ${run.runId}`);
      throw e;
    }
  }

  async getRun(id: string): Promise<Run | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tables.runs, Key: { runId: id }, ConsistentRead: true }));
    return res.Item ? (res.Item as Run) : undefined;
  }

  async listRuns(): Promise<Run[]> {
    const items = await this.scanAll({ TableName: this.tables.runs, ConsistentRead: true });
    return (items as unknown as Run[]).sort((a, b) => a.createdAt - b.createdAt);
  }

  async updateRun(id: string, patch: Partial<Run>, expectedState?: RunState): Promise<Run> {
    const { UpdateExpression, names, values } = buildUpdate(patch as Record<string, unknown>, ["runId"]);
    let condition = "attribute_exists(runId)";
    if (expectedState !== undefined) {
      names["#state"] = "state";
      values[":expectedState"] = expectedState;
      condition += " AND #state = :expectedState";
    }
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.runs,
          Key: { runId: id },
          UpdateExpression,
          ConditionExpression: condition,
          ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
          ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
          ReturnValues: "ALL_NEW",
        }),
      );
      return res.Attributes as Run;
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      const current = await this.getRun(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      throw new Conflict(`Run ${id} is in state ${current.state}, expected ${expectedState}`);
    }
  }

  async appendStep(rec: StepRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.steps,
        Item: { ...clean(rec), sk: `${rec.step}#${pad(rec.attempt, 6)}` },
      }),
    );
  }

  async updateStep(runId: string, step: string, attempt: number, patch: Partial<StepRecord>): Promise<void> {
    const { UpdateExpression, names, values } = buildUpdate(patch as Record<string, unknown>, ["runId", "step", "attempt"]);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.steps,
          Key: { runId, sk: `${step}#${pad(attempt, 6)}` },
          UpdateExpression,
          ConditionExpression: "attribute_exists(runId)",
          ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
          ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
        }),
      );
    } catch (e) {
      if (isConditionFailure(e)) throw new Error(`Step not found: ${runId}/${step}/${attempt}`);
      throw e;
    }
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const items = await this.queryAll({
      TableName: this.tables.steps,
      KeyConditionExpression: "runId = :r",
      ExpressionAttributeValues: { ":r": runId },
      ConsistentRead: true,
    });
    return items
      .map((i) => stripKeys<StepRecord>(i, "sk"))
      .sort((a, b) => a.startedAt - b.startedAt || a.attempt - b.attempt);
  }

  async addVersion(v: Version): Promise<void> {
    const expectedN = v.parent === null ? 1 : v.parent + 1;
    if (v.n !== expectedN) {
      throw new Conflict(`Version chain violation for ${v.runId}: got n=${v.n} parent=${v.parent}`);
    }
    const versionPut = {
      Put: {
        TableName: this.tables.versions,
        Item: clean(v),
        ConditionExpression: "attribute_not_exists(runId)",
      },
    };
    const pointer =
      v.parent === null
        ? {
            Put: {
              TableName: this.tables.versions,
              Item: { runId: v.runId, n: 0, latest: v.n },
              ConditionExpression: "attribute_not_exists(runId)",
            },
          }
        : {
            Update: {
              TableName: this.tables.versions,
              Key: { runId: v.runId, n: 0 },
              UpdateExpression: "SET #latest = :n",
              ConditionExpression: "#latest = :parent",
              ExpressionAttributeNames: { "#latest": "latest" },
              ExpressionAttributeValues: { ":n": v.n, ":parent": v.parent },
            },
          };
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: [pointer, versionPut] }));
    } catch (e) {
      if (isChainConflict(e)) {
        throw new Conflict(`Version chain violation for ${v.runId}: n=${v.n} parent=${v.parent}`);
      }
      throw e;
    }
  }

  async listVersions(runId: string): Promise<Version[]> {
    const items = await this.queryAll({
      TableName: this.tables.versions,
      KeyConditionExpression: "runId = :r AND #n >= :one",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":r": runId, ":one": 1 },
      ConsistentRead: true,
    });
    return items as unknown as Version[];
  }

  async getVersion(runId: string, n: number): Promise<Version | undefined> {
    if (n < 1) return undefined;
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.versions, Key: { runId, n }, ConsistentRead: true }),
    );
    return res.Item ? (res.Item as Version) : undefined;
  }

  // One transaction: a ConditionCheck that the latest pointer still equals n (a newer version
  // invalidates the sign-off of this one), plus a conditional Update of the version item. Needs
  // dynamodb:ConditionCheckItem in the app policy (Infra/lib/data-stack.ts).
  async addSignature(input: Signature): Promise<Version> {
    // userIds are stored and compared normalised (signoff/identity.ts), so "Alice" and "alice" are one person.
    let sig: Signature;
    try {
      sig = { ...input, userId: normaliseUserId(input.userId) };
    } catch (e) {
      if (e instanceof InvalidUserId) throw new Conflict(`Signature refused for ${input.runId} v${input.n} (${input.role}): invalid userId`);
      throw e;
    }
    const names: Record<string, string> = { "#sigs": "signatures", "#status": "status" };
    const values: Record<string, unknown> = { ":one": [clean(sig)], ":locked": "locked", ":rejected": "rejected" };
    let condition = "attribute_exists(runId) AND (attribute_not_exists(#status) OR (#status <> :locked AND #status <> :rejected))";
    let update: string;
    if (sig.role === "program_officer") {
      condition += " AND (attribute_not_exists(#sigs) OR size(#sigs) = :zero)";
      values[":zero"] = 0;
      update = "SET #sigs = :one";
    } else {
      names["#role"] = "role";
      names["#sha"] = "modelSha";
      names["#user"] = "userId";
      names["#set"] = "settingsSha";
      Object.assign(values, { ":count": 1, ":officer": "program_officer", ":sha": sig.modelSha, ":user": sig.userId, ":at": sig.signedAt });
      condition +=
        " AND size(#sigs) = :count AND #sigs[0].#role = :officer AND #sigs[0].#sha = :sha AND #sigs[0].#user <> :user";
      if (sig.settingsSha === undefined) condition += " AND attribute_not_exists(#sigs[0].#set)";
      else {
        values[":set"] = sig.settingsSha;
        condition += " AND #sigs[0].#set = :set";
      }
      names["#lockedAt"] = "lockedAt";
      update = "SET #sigs = list_append(#sigs, :one), #status = :locked, #lockedAt = :at";
    }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tables.versions,
                Key: { runId: sig.runId, n: 0 },
                ConditionExpression: "#latest = :n",
                ExpressionAttributeNames: { "#latest": "latest" },
                ExpressionAttributeValues: { ":n": sig.n },
              },
            },
            {
              Update: {
                TableName: this.tables.versions,
                Key: { runId: sig.runId, n: sig.n },
                UpdateExpression: update,
                ConditionExpression: condition,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (isChainConflict(e)) throw new Conflict(`Signature refused for ${sig.runId} v${sig.n} (${sig.role})`);
      throw e;
    }
    const v = await this.getVersion(sig.runId, sig.n);
    if (!v) throw new Error(`Version not found after signing: ${sig.runId} v${sig.n}`);
    return v;
  }

  // Same shape as addSignature: a ConditionCheck on the latest pointer plus a conditional Update.
  async rejectVersion(runId: string, n: number, input: Rejection): Promise<Version> {
    let rejection: Rejection;
    try {
      rejection = { ...input, userId: normaliseUserId(input.userId) };
    } catch (e) {
      if (e instanceof InvalidUserId) throw new Conflict(`Rejection refused for ${runId} v${n}: invalid userId`);
      throw e;
    }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tables.versions,
                Key: { runId, n: 0 },
                ConditionExpression: "#latest = :n",
                ExpressionAttributeNames: { "#latest": "latest" },
                ExpressionAttributeValues: { ":n": n },
              },
            },
            {
              Update: {
                TableName: this.tables.versions,
                Key: { runId, n },
                UpdateExpression: "SET #status = :rejected, #rej = :rej",
                ConditionExpression:
                  "attribute_exists(runId) AND (attribute_not_exists(#status) OR (#status <> :locked AND #status <> :rejected))" +
                  " AND size(#sigs) = :count AND #sigs[0].#role = :officer AND #sigs[0].#sha = :sha AND #sigs[0].#user <> :user",
                ExpressionAttributeNames: { "#status": "status", "#rej": "rejection", "#sigs": "signatures", "#role": "role", "#sha": "modelSha", "#user": "userId" },
                ExpressionAttributeValues: {
                  ":rejected": "rejected",
                  ":locked": "locked",
                  ":rej": clean(rejection),
                  ":count": 1,
                  ":officer": "program_officer",
                  ":sha": rejection.modelSha,
                  ":user": rejection.userId,
                },
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (isChainConflict(e)) throw new Conflict(`Rejection refused for ${runId} v${n}`);
      throw e;
    }
    const v = await this.getVersion(runId, n);
    if (!v) throw new Error(`Version not found after rejecting: ${runId} v${n}`);
    return v;
  }

  async addComment(c: Comment): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.comments,
        Item: { ...clean(c), sk: `${pad(c.n, 10)}#${pad(c.createdAt, 15)}#${randomUUID()}` },
      }),
    );
  }

  async listComments(runId: string, n: number): Promise<Comment[]> {
    const items = await this.queryAll({
      TableName: this.tables.comments,
      KeyConditionExpression: "runId = :r AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":r": runId, ":p": `${pad(n, 10)}#` },
      ConsistentRead: true,
    });
    return items.map((i) => stripKeys<Comment>(i, "sk"));
  }

  async appendAudit(runId: string, event: AuditEvent): Promise<void> {
    const seq = this.auditSeq++;
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.audit,
        Item: {
          runId,
          sk: `${pad(event.at, 15)}#${pad(seq, 10)}#${randomUUID()}`,
          at: event.at,
          type: event.type,
          detail: clean({ d: event.detail }).d ?? null,
        },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  }

  async listAudit(runId: string): Promise<AuditEvent[]> {
    const items = await this.queryAll({
      TableName: this.tables.audit,
      KeyConditionExpression: "runId = :r",
      ExpressionAttributeValues: { ":r": runId },
      ConsistentRead: true,
    });
    return items.map((i) => stripKeys<AuditEvent>(i, "runId", "sk"));
  }

  async acquireLease(runId: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.runs,
          Key: { runId },
          UpdateExpression: "SET #lease = :lease",
          ConditionExpression:
            "attribute_exists(runId) AND (attribute_not_exists(#lease) OR #lease.expiresAt <= :now OR #lease.#owner = :owner)",
          ExpressionAttributeNames: { "#lease": "lease", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":lease": { owner, expiresAt: now + ttlMs },
            ":now": now,
            ":owner": owner,
          },
        }),
      );
      return true;
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      if (!(await this.getRun(runId))) throw new Error(`Run not found: ${runId}`);
      return false;
    }
  }

  async releaseLease(runId: string, owner: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.runs,
          Key: { runId },
          UpdateExpression: "REMOVE #lease",
          // Fails (no-op) when another owner holds the lease, there is none, or the run is unknown.
          ConditionExpression: "#lease.#owner = :owner",
          ExpressionAttributeNames: { "#lease": "lease", "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": owner },
        }),
      );
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
    }
  }

  async listResumable(now: number): Promise<Run[]> {
    const names: Record<string, string> = { "#state": "state", "#lease": "lease" };
    const values: Record<string, unknown> = { ":now": now };
    WORK_STATES.forEach((s, i) => {
      values[`:s${i}`] = s;
    });
    const items = await this.scanAll({
      TableName: this.tables.runs,
      ConsistentRead: true,
      FilterExpression: `#state IN (${WORK_STATES.map((_, i) => `:s${i}`).join(", ")}) AND (attribute_not_exists(#lease) OR #lease.expiresAt <= :now)`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    });
    return (items as unknown as Run[]).sort((a, b) => a.createdAt - b.createdAt);
  }
}
