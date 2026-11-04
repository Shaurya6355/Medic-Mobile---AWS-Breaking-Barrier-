import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Message { id: string; body: string; receiveCount: number }

/** What the worker needs from a queue. LocalQueue implements it on disk; an SQS adapter replaces it on AWS. */
export interface Queue {
  send(body: string): Promise<void>;
  /** Returns up to `max` visible messages and hides them for the visibility timeout. */
  receive(max: number): Promise<Message[]>;
  delete(id: string): Promise<void>;
  /** Gives up on a message after too many receives (SQS redrive to a dead-letter queue). */
  deadLetter(id: string): Promise<void>;
}

/**
 * Local stand-in for SQS. One JSON file per message, so messages survive a restart.
 * Visibility timeout and receive counts are kept in memory, like an SQS in-flight message.
 */
export class LocalQueue implements Queue {
  private readonly hiddenUntil = new Map<string, number>();
  private readonly receives = new Map<string, number>();
  private readonly ready: Promise<void>;
  private readonly dir: string;
  private readonly visibilityTimeoutMs: number;
  constructor(dir: string, visibilityTimeoutMs: number) {
    this.dir = dir;
    this.visibilityTimeoutMs = visibilityTimeoutMs;
    this.ready = Promise.all([mkdir(dir, { recursive: true }), mkdir(path.join(dir, "dlq"), { recursive: true })]).then(() => undefined);
  }

  async send(body: string): Promise<void> {
    await this.ready;
    const id = `${Date.now().toString().padStart(15, "0")}-${randomUUID()}.json`;
    const tmp = path.join(this.dir, "." + id);
    await writeFile(tmp, body);
    await rename(tmp, path.join(this.dir, id));
  }

  async receive(max: number): Promise<Message[]> {
    await this.ready;
    const now = Date.now();
    const ids = (await readdir(this.dir)).filter(f => f.endsWith(".json") && !f.startsWith(".")).sort();
    const out: Message[] = [];
    for (const id of ids) {
      if (out.length >= max) break;
      if ((this.hiddenUntil.get(id) ?? 0) > now) continue;
      const body = await readFile(path.join(this.dir, id), "utf8").catch(() => null);
      if (body === null) continue;
      this.hiddenUntil.set(id, now + this.visibilityTimeoutMs);
      const receiveCount = (this.receives.get(id) ?? 0) + 1;
      this.receives.set(id, receiveCount);
      out.push({ id, body, receiveCount });
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    await unlink(path.join(this.dir, id)).catch(() => undefined);
    this.hiddenUntil.delete(id);
    this.receives.delete(id);
  }

  async deadLetter(id: string): Promise<void> {
    await rename(path.join(this.dir, id), path.join(this.dir, "dlq", id)).catch(() => undefined);
    this.hiddenUntil.delete(id);
    this.receives.delete(id);
  }
}
