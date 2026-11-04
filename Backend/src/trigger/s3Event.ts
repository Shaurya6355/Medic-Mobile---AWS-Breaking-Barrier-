import { parseInputKey } from "../artifacts/artifactStore.js";

export interface UploadedObject {
  bucket: string;
  key: string;
  runId: string;
}

function decodeKey(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

// Parses an S3 event notification delivered straight to SQS. Never throws; anything that is
// not an object-created event for a run's input PDF yields no entries.
export function parseS3Event(messageBody: string): UploadedObject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageBody);
  } catch {
    return [];
  }
  if (!isObject(parsed) || !Array.isArray(parsed.Records)) return [];
  const out: UploadedObject[] = [];
  for (const rec of parsed.Records as unknown[]) {
    if (!isObject(rec)) continue;
    if (rec.eventName !== undefined && !(typeof rec.eventName === "string" && rec.eventName.startsWith("ObjectCreated:"))) continue;
    const s3 = rec.s3;
    if (!isObject(s3) || !isObject(s3.bucket) || !isObject(s3.object)) continue;
    const bucket = s3.bucket.name;
    const rawKey = s3.object.key;
    if (typeof bucket !== "string" || typeof rawKey !== "string") continue;
    const key = decodeKey(rawKey);
    if (key === undefined) continue;
    const runId = parseInputKey(key);
    if (runId === undefined) continue;
    out.push({ bucket, key, runId });
  }
  return out;
}
