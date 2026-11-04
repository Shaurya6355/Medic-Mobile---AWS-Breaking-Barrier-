import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { NotFound, type ArtifactStore } from "./artifactStore.js";

const isMissing = (e: unknown): boolean =>
  e instanceof Error && (e.name === "NoSuchKey" || e.name === "NotFound");

export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Uint8Array | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new NotFound(`Artifact has no body: ${key}`);
      return await out.Body.transformToByteArray();
    } catch (e) {
      if (isMissing(e)) throw new NotFound(`Artifact not found: ${key}`);
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }
}
