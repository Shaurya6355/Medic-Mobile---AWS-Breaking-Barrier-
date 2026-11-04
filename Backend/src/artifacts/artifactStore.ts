export interface ArtifactStore {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
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
}

export function inputPdfKey(runId: string): string {
  return artifactKey(runId, "input", "guideline.pdf");
}
