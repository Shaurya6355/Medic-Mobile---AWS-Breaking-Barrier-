import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type GuidelineType = "PDF" | "Word" | "Spreadsheet" | "Image" | "Web or text" | "Other";
export type GuidelineStatus = "Uploading" | "Processing" | "Indexed" | "Unsupported" | "Failed";
export type StepKey = "upload" | "event" | "extract" | "digest" | "logic_model";
export type StepState = "pending" | "running" | "done" | "failed";
export interface Step { key: StepKey; label: string; state: StepState; startedAt?: string; endedAt?: string; detail?: string }

export interface GuidelineRecord {
  id: string;
  name: string;
  type: GuidelineType;
  size: number;
  createdAt: string;
  status: GuidelineStatus;
  pages: number | null;
  steps: Step[];
  keys: { upload: string; extracted?: string; digested?: string; logicModel?: string };
  error?: string;
  blocks?: number;
  logicModel?: { source: "placeholder" | "agent"; builder: string; quotesFound: number; quotesTotal: number; quotesOnPage: number };
}

export const STEP_LABELS: Record<StepKey, string> = {
  upload: "Upload to S3",
  event: "S3 event picked up by worker",
  extract: "Extract text",
  digest: "Digest into blocks",
  logic_model: "Build logic model",
};
export const newSteps = (): Step[] => (Object.keys(STEP_LABELS) as StepKey[]).map(key => ({ key, label: STEP_LABELS[key], state: "pending" }));

const TYPE_BY_EXT: Record<string, GuidelineType> = {
  pdf: "PDF", doc: "Word", docx: "Word", odt: "Word", rtf: "Word",
  xlsx: "Spreadsheet", xls: "Spreadsheet", csv: "Spreadsheet", ods: "Spreadsheet",
  png: "Image", jpg: "Image", jpeg: "Image", tif: "Image", tiff: "Image", webp: "Image",
  html: "Web or text", htm: "Web or text", txt: "Web or text", md: "Web or text",
};
export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
export const typeOf = (name: string): GuidelineType => TYPE_BY_EXT[extOf(name)] ?? "Other";

/**
 * Guideline records, one JSON file. Local stand-in for a DynamoDB table.
 * Writes are serialised so concurrent updates from the server and the worker never interleave.
 */
export class GuidelineStore {
  private rows = new Map<string, GuidelineRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private constructor(dir: string) { this.file = path.join(dir, "guidelines.json"); }

  static async open(dir: string): Promise<GuidelineStore> {
    await mkdir(dir, { recursive: true });
    const s = new GuidelineStore(dir);
    const raw = await readFile(s.file, "utf8").catch(() => "[]");
    for (const r of JSON.parse(raw) as GuidelineRecord[]) s.rows.set(r.id, r);
    return s;
  }

  list(): GuidelineRecord[] { return [...this.rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get(id: string): GuidelineRecord | undefined { const r = this.rows.get(id); return r && structuredClone(r); }

  put(r: GuidelineRecord): Promise<void> { this.rows.set(r.id, structuredClone(r)); return this.flush(); }

  /** Read-modify-write one record. */
  update(id: string, fn: (r: GuidelineRecord) => void): Promise<GuidelineRecord> {
    const r = this.rows.get(id);
    if (!r) return Promise.reject(new Error("Guideline not found: " + id));
    fn(r);
    return this.flush().then(() => structuredClone(r));
  }

  step(id: string, key: StepKey, state: StepState, detail?: string): Promise<GuidelineRecord> {
    return this.update(id, r => {
      const s = r.steps.find(x => x.key === key)!;
      const now = new Date().toISOString();
      if (state === "running") s.startedAt = now;
      if (state === "done" || state === "failed") { s.startedAt ??= now; s.endedAt = now; }
      s.state = state;
      if (detail !== undefined) s.detail = detail;
    });
  }

  private flush(): Promise<void> {
    const next = this.chain.then(async () => {
      const tmp = this.file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.list(), null, 2));
      await rename(tmp, this.file);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
