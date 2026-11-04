import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** S3 event notification body, the shape S3 sends to SQS. Only the fields the worker reads. */
export interface S3EventRecord {
  eventVersion: string;
  eventSource: "aws:s3";
  awsRegion: string;
  eventTime: string;
  eventName: string;
  s3: { bucket: { name: string }; object: { key: string; size: number } };
}
export interface S3Event { Records: S3EventRecord[] }

/** What the pipeline needs from a bucket. LocalObjectStore implements it on disk; an S3 adapter replaces it on AWS. */
export interface ObjectStore {
  readonly bucket: string;
  put(key: string, body: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** A time-limited URL the browser can PUT the file to. */
  presignPut(key: string, expiresSeconds: number): string;
  uri(key: string): string;
}

const KEY_RE = /^[A-Za-z0-9._\-/]+$/;
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.split("/").some(p => p === "" || p === "." || p === "..")) throw new Error("Invalid object key: " + key);
}

export interface LocalStoreOptions {
  publicUrl: string;
  region: string;
  notifyPrefixes: string[];
  onObjectCreated: (e: S3Event) => Promise<void>;
}

/**
 * Local stand-in for an S3 bucket. Objects live under <dir>/<key>.
 * Like an S3 bucket notification, every new object under one of `notifyPrefixes` calls `onObjectCreated`
 * with an S3-shaped event, which the server sends to the queue.
 */
export class LocalObjectStore implements ObjectStore {
  private readonly secret = randomBytes(32);
  readonly bucket: string;
  private readonly dir: string;
  private readonly opts: LocalStoreOptions;
  constructor(bucket: string, dir: string, opts: LocalStoreOptions) {
    this.bucket = bucket;
    this.dir = dir;
    this.opts = opts;
  }

  private file(key: string): string {
    assertKey(key);
    const f = path.resolve(this.dir, key);
    if (!f.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("Key escapes bucket: " + key);
    return f;
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
    if (this.opts.notifyPrefixes.some(p => key.startsWith(p))) {
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.length;
      await this.opts.onObjectCreated({
        Records: [{
          eventVersion: "2.1", eventSource: "aws:s3", awsRegion: this.opts.region, eventTime: new Date().toISOString(),
          eventName: "ObjectCreated:Put", s3: { bucket: { name: this.bucket }, object: { key: encodeURIComponent(key).replace(/%2F/g, "/"), size } },
        }],
      });
    }
  }

  get(key: string): Promise<Buffer> { return readFile(this.file(key)); }
  async exists(key: string): Promise<boolean> { return stat(this.file(key)).then(() => true, () => false); }
  async remove(key: string): Promise<void> { await rm(this.file(key), { force: true }); }
  uri(key: string): string { return `s3://${this.bucket}/${key}`; }

  private sign(key: string, expires: number): string {
    return createHmac("sha256", this.secret).update(key + "\n" + expires).digest("hex");
  }
  presignPut(key: string, expiresSeconds: number): string {
    assertKey(key);
    const expires = Math.floor(Date.now() / 1000) + expiresSeconds;
    return `${this.opts.publicUrl}/local-s3/${this.bucket}/${key}?X-Expires=${expires}&X-Signature=${this.sign(key, expires)}`;
  }
  /** Checks a presigned URL's signature and expiry, as S3 would. */
  verifyPut(key: string, expires: string | null, signature: string | null): boolean {
    if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(key, Number(expires)), "hex");
    const got = Buffer.from(signature, "hex");
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
