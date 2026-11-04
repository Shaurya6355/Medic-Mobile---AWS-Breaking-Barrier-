/* The only place that reads or writes data.
   Guidelines: with VITE_API_URL set ("live"), files go through the backend pipeline
   (presigned upload to S3, S3 event, extract, digest, logic model) and drafts start from the pipeline's logic model JSON.
   Without it, an in-memory store seeded with the mockup's sample data.
   Workflow steps after the draft still run the domain state machine in memory. */
import { clone, fnv, loadSpec } from "../domain/data";
import * as wf from "../domain/workflow";
import type { AuditRow, Decision, Guideline, GuidelineType, ItemId, Patch, SuggestionOutcome, Workflow } from "../domain/types";

export const API_URL: string | undefined = import.meta.env.VITE_API_URL?.replace(/\/+$/, "") || undefined;
/** True when guidelines come from the backend pipeline rather than sample data. */
export const LIVE = !!API_URL;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(API_URL + path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); }
  catch { throw new Error("Can't reach the pipeline backend at " + API_URL + ". Is it running (cd Backend && npm run dev)?"); }
  const body = await r.json().catch(() => null) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(body?.error || "Backend returned " + r.status + " for " + path);
  return body as T;
}

/** PUT to a presigned URL with upload progress (fetch has no upload progress). */
function putFile(url: string, file: File, headers: Record<string, string>, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    Object.entries(headers).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error("Upload to S3 failed (" + x.status + ")")));
    x.onerror = () => reject(new Error("Upload to S3 failed (network error)"));
    x.send(file);
  });
}

interface LogicModelEnvelope {
  builder: string; source: "placeholder" | "agent"; notes: string[];
  quoteCheck: { found: number; total: number; onPage?: number };
  /** Pathway spec JSON. Validated here again before use: the UI never trusts the wire. */
  model: unknown;
  /** Draft B for the cross check, when the builder produced one. */
  draftB?: unknown;
}
interface DigestBody { blocks: { page: number; text: string }[] }

export const ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.xlsx,.xls,.csv,.ods,.png,.jpg,.jpeg,.tif,.tiff,.webp,.html,.htm,.txt,.md";
const TYPE_BY_EXT: Record<string, GuidelineType> = {
  pdf: "PDF", doc: "Word", docx: "Word", odt: "Word", rtf: "Word",
  xlsx: "Spreadsheet", xls: "Spreadsheet", csv: "Spreadsheet", ods: "Spreadsheet",
  png: "Image", jpg: "Image", jpeg: "Image", tif: "Image", tiff: "Image", webp: "Image",
  html: "Web or text", htm: "Web or text", txt: "Web or text", md: "Web or text",
};

/* ---------- In-memory store (sample data) ---------- */
let guidelines: Guideline[] = LIVE ? [] : [
  { id: "g-imci", name: "IMCI chart booklet (sample).pdf", type: "PDF", meta: "80 pages · 6.1 MB · Textract", status: "Indexed", pages: 80 },
  { id: "g-nat", name: "National child health guideline 2025 (sample).pdf", type: "PDF", meta: "142 pages · 11.4 MB · Textract + model", status: "Indexed", pages: 142 },
  { id: "g-dak", name: "Child health DAK decision tables (sample).xlsx", type: "Spreadsheet", meta: "6 sheets · cells read directly", status: "Indexed", pages: null },
  { id: "g-memo", name: "District cough protocol memo (sample).docx", type: "Word", meta: "12 pages · converted to PDF, then Textract", status: "Uploaded", pages: 12 },
];
const workflows: Record<string, Workflow> = {};
let seq = 1;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function respond<T>(v: T, ms = 60): Promise<T> { await wait(ms); return clone(v); }
function load(id: string): Workflow {
  const w = workflows[id];
  if (!w) throw new Error("Workflow " + id + " not found");
  return w;
}
async function mutate(id: string, fn: (w: Workflow) => Workflow): Promise<Workflow> {
  const next = fn(load(id));
  workflows[id] = next;
  return respond(next);
}

/* ---------- Guidelines ---------- */
/** Live: get a presigned URL, PUT the file to S3. The S3 event starts the pipeline; poll getGuideline for progress. */
export async function uploadGuideline(file: File, onProgress?: (pct: number) => void): Promise<Guideline> {
  if (LIVE) {
    const r = await http<{ guideline: Guideline; upload: { url: string; headers: Record<string, string> } }>("/guidelines/upload-url", {
      method: "POST", body: JSON.stringify({ fileName: file.name, size: file.size, contentType: file.type || undefined }),
    });
    await putFile(r.upload.url, file, r.upload.headers, onProgress);
    return r.guideline;
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = TYPE_BY_EXT[ext] || "Other";
  const size = Math.max(1, Math.round(file.size / 1024)) + " KB";
  await wait(900);
  const g: Guideline = {
    id: "g-" + fnv(file.name + Date.now()), name: file.name, type, pages: null,
    meta: size + (type === "Other" ? " · in S3 · this file type can't be read" : " · in S3 · indexed just now"),
    status: type === "Other" ? "Unsupported" : "Indexed",
  };
  guidelines = guidelines.concat(g);
  return respond(g);
}
export const listGuidelines = (): Promise<Guideline[]> => (LIVE ? http<Guideline[]>("/guidelines") : respond(guidelines));
export const getGuideline = (id: string): Promise<Guideline> => (LIVE ? http<Guideline>("/guidelines/" + id) : respond(guidelines.find(g => g.id === id)!));

/* ---------- Workflow ---------- */
export async function createDraft(args: { guidelineId: string; pathway: string; pages: number[] }): Promise<Workflow> {
  const id = "wf-" + seq++;
  if (LIVE) {
    const g = await getGuideline(args.guidelineId);
    const env = await http<LogicModelEnvelope>("/guidelines/" + g.id + "/logic-model");
    const model = loadSpec(env.model, "The pipeline's logic model");
    const digest = await http<DigestBody>("/guidelines/" + g.id + "/digest").catch(() => null);
    const byPage = new Map<number, string[]>();
    digest?.blocks.forEach(b => byPage.set(b.page, [...(byPage.get(b.page) ?? []), b.text]));
    const evidence = {
      pages: digest ? [...byPage].map(([page, lines]) => ({ page, text: lines.join("\n") })) : null,
      pagesFrom: g.name + " (text extracted by the pipeline" + (g.pages ? ", " + g.pages + " pages" : "") + ")",
      draftB: env.draftB ? loadSpec(env.draftB, "The pipeline's draft B") : null,
      draftBFrom: "Draft B from " + env.builder + (env.source === "placeholder" ? " (placeholder sample)" : ""),
    };
    const qc = env.quoteCheck.found + " of " + env.quoteCheck.total + " source quotes found in this file" + (env.quoteCheck.onPage !== undefined ? ", " + env.quoteCheck.onPage + " on the cited page" : "");
    workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages }, {
      model, evidence,
      event: env.source === "placeholder" ? "Loaded placeholder logic model (no model connected yet)" : "Loaded logic model from " + env.builder,
      note: (g.s3Uri ? g.s3Uri.replace(/\/uploads\/.*/, "/logic-models/" + g.id + "/logic-model.json") + " · " : "") + qc,
    });
    return clone(workflows[id]);
  }
  const g = guidelines.find(x => x.id === args.guidelineId);
  if (!g) throw new Error("Guideline not found");
  workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages });
  return respond(workflows[id], 400);
}
export const getWorkflow = async (id: string) => respond(load(id));
export const saveEdit = (id: string, patch: { item: ItemId; field: string; patch: Patch }) => mutate(id, w => wf.applyEdit(w, patch.item, patch.field, patch.patch));
export const sendToClinician = (id: string) => mutate(id, wf.sendToClinician);
export const submitReview = (id: string, itemId: ItemId, decision: Decision | null) => mutate(id, w => wf.submitReview(w, itemId, decision));
export const decideFlag = (id: string, flagId: string, choice: number, note: string) => mutate(id, w => wf.decideFlag(w, flagId, choice, note));
export const returnToPO = (id: string) => mutate(id, wf.returnToPO);
export const decideSuggestion = (id: string, itemId: ItemId, outcome: SuggestionOutcome, patch?: Patch) => mutate(id, w => wf.decideSuggestion(w, itemId, outcome, patch));
export const approve = (id: string) => mutate(id, wf.approveAll);
export const runVerify = (id: string) => mutate(id, wf.runVerify);
export const approveDeploy = (id: string) => mutate(id, wf.approveDeploy);
export const getAudit = async (id: string): Promise<AuditRow[]> => respond(load(id).audit);
