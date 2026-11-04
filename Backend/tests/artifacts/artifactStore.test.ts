import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound as S3NotFound,
} from "@aws-sdk/client-s3";
import { artifactKey, MemoryArtifactStore } from "../../src/artifacts/artifactStore.js";
import { S3ArtifactStore } from "../../src/artifacts/s3ArtifactStore.js";

describe("artifactKey", () => {
  it("builds runs/<runId>/<parts>", () => {
    expect(artifactKey("r1", "extract", "out.json")).toBe("runs/r1/extract/out.json");
    expect(artifactKey("r1")).toBe("runs/r1/");
  });
});

describe("MemoryArtifactStore", () => {
  it("round-trips bytes and strings, reports exists, throws NotFound", async () => {
    const s = new MemoryArtifactStore();
    await s.put("a", new Uint8Array([1, 2, 3]));
    await s.put("b", "hello", "text/plain");
    expect(Array.from(await s.get("a"))).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(await s.get("b"))).toBe("hello");
    expect(await s.exists("a")).toBe(true);
    expect(await s.exists("zz")).toBe(false);
    await expect(s.get("zz")).rejects.toMatchObject({ name: "NotFound" });
  });

  it("does not alias stored bytes", async () => {
    const s = new MemoryArtifactStore();
    const src = new Uint8Array([1]);
    await s.put("a", src);
    src[0] = 9;
    expect((await s.get("a"))[0]).toBe(1);
  });
});

describe("S3ArtifactStore", () => {
  const s3 = mockClient(S3Client);
  beforeEach(() => s3.reset());
  const store = () => new S3ArtifactStore(new S3Client({ region: "us-west-2" }), "test-bucket");

  it("put issues PutObject with bucket, key, body and content type", async () => {
    s3.on(PutObjectCommand).resolves({});
    await store().put("runs/r1/x", "body", "text/plain");
    const call = s3.commandCalls(PutObjectCommand)[0]!;
    expect(call.args[0].input).toMatchObject({
      Bucket: "test-bucket",
      Key: "runs/r1/x",
      Body: "body",
      ContentType: "text/plain",
    });
  });

  it("get reads bytes from GetObject", async () => {
    s3.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([7, 8]) } as never,
    });
    expect(Array.from(await store().get("k"))).toEqual([7, 8]);
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toEqual({ Bucket: "test-bucket", Key: "k" });
  });

  it("get translates NoSuchKey into an error named NotFound", async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "x", $metadata: {} }));
    await expect(store().get("k")).rejects.toMatchObject({ name: "NotFound" });
  });

  it("exists uses HeadObject; NotFound means false", async () => {
    s3.on(HeadObjectCommand, { Key: "yes" }).resolves({});
    s3.on(HeadObjectCommand, { Key: "no" }).rejects(new S3NotFound({ message: "x", $metadata: {} }));
    expect(await store().exists("yes")).toBe(true);
    expect(await store().exists("no")).toBe(false);
  });

  it("exists rethrows other errors", async () => {
    s3.on(HeadObjectCommand).rejects(new Error("boom"));
    await expect(store().exists("k")).rejects.toThrow("boom");
  });
});
