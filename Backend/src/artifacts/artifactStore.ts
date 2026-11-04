export interface ArtifactStore {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  // Size in bytes without reading the body (HeadObject). Throws NotFound when the key is missing.
  size(key: string): Promise<number>;
}

export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

export function artifactKey(runId: string, ...parts: string[]): string {
  return `runs/${runId}/${parts.join("/")}`;
}

// For tests and local dev only.
export class MemoryArtifactStore implements ArtifactStore {
  private objects = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array | string, _contentType?: string): Promise<void> {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body));
  }

  async get(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new NotFound(`Artifact not found: ${key}`);
    return new Uint8Array(o);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async size(key: string): Promise<number> {
    const o = this.objects.get(key);
    if (!o) throw new NotFound(`Artifact not found: ${key}`);
    return o.byteLength;
  }
}

export function inputPdfKey(runId: string): string {
  return artifactKey(runId, "input", "guideline.pdf");
}

// Inverse of inputPdfKey: returns the run ID if the key is exactly the input PDF key of some run.
// The format is defined once, by inputPdfKey; the run ID is a single path segment of [A-Za-z0-9-]+.
const KEY_MARKER = "MARKER";
const [KEY_PREFIX = "", KEY_SUFFIX = ""] = inputPdfKey(KEY_MARKER).split(KEY_MARKER);

export function parseInputKey(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX) || !key.endsWith(KEY_SUFFIX)) return undefined;
  if (key.length <= KEY_PREFIX.length + KEY_SUFFIX.length) return undefined;
  const runId = key.slice(KEY_PREFIX.length, key.length - KEY_SUFFIX.length);
  return /^[A-Za-z0-9-]+$/.test(runId) ? runId : undefined;
}

// Canonical stored name of a page image: page number padded to at least 2 digits
// (page-07.png, page-123.png). Ingest writes it and extract reads it.
export function pageImageName(pdfPage: number): string {
  return `page-${String(pdfPage).padStart(2, "0")}.png`;
}
