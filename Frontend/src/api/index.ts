/* The only place that reads or writes data.
   Live (VITE_API_URL set): the orchestrator API in Backend/src (contract: Backend/src/contract/routes.ts).
     A guideline is a run: POST /runs gives a presigned S3 URL, the upload starts ingest -> extract -> fill_logic -> checks.
     The review starts from the run's latest version. Approving saves the clinician's version and signs it twice:
     the AI agent as program_officer, then the clinician (the backend's sign-off order and separation of duties).
   Without VITE_API_URL: an in-memory store seeded with sample data.
   Edits, the assistant and the checks run in the browser; nothing reaches the backend until approval. */
import { clone, fnv, loadSpec } from "../domain/data";
import * as wf from "../domain/workflow";
import type { AuditRow, Guideline, GuidelineType, ItemId, Patch, Spec, Workflow } from "../domain/types";

export const API_URL: string | undefined = import.meta.env.VITE_API_URL?.replace(/\/+$/, "") || undefined;
/** True when guidelines come from the backend pipeline rather than sample data. */
export const LIVE = !!API_URL;

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

/* ---------- Orchestrator API shapes (Backend/src/domain/types.ts, signoff/signoff.ts) ---------- */
type RunState = "created" | "ingesting" | "extracting" | "filling_logic" | "in_review" | "checking" | "awaiting_officer" | "awaiting_clinician" | "locked" | "failed";
interface Run { runId: string; state: RunState; pages?: number[]; currentStep?: string; createdAt: number }
interface StepRecord { step: string; attempt: number; status: "running" | "succeeded" | "failed"; startedAt: number; endedAt?: number; error?: string }
interface VersionRec { n: number; author: string; authorRole?: string; createdAt: number; status?: string }
interface FindingsView { modelSha: string; claimText: string; blocking: number; groups: { severity: "blocking" | "warning" | "info"; findings: { message: string; check: string }[] }[] }
interface StatusView { n: number; modelSha: string; status: string; runState: RunState; nextStep: string }

/** The AI agent's identity when it signs in the program officer's place. */
const AGENT_ID = "ai-agent";
const CLINICIAN_ID = (import.meta.env.VITE_CLINICIAN_ID as string | undefined) || "clinician";

const WORK: [RunState, string][] = [["created", "Upload to S3"], ["ingesting", "Read pages"], ["extracting", "Extract"], ["filling_logic", "Draft logic model"], ["checking", "Backend checks"]];
const READY: RunState[] = ["in_review", "awaiting_officer", "awaiting_clinician", "locked"];
const names = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem("runNames") || "{}"); } catch { return {}; } };
const nameRun = (id: string, n: string) => { try { localStorage.setItem("runNames", JSON.stringify({ ...names(), [id]: n })); } catch { /* private mode */ } };

function toGuideline(r: Run, steps?: StepRecord[]): Guideline {
  const failed = r.state === "failed", ready = READY.includes(r.state);
  const at = WORK.findIndex(([s]) => s === r.state);
  const err = steps?.filter(s => s.status === "failed").pop()?.error;
  return {
    id: r.runId, name: names()[r.runId] ?? "Run " + r.runId.slice(0, 8), type: "PDF",
    meta: new Date(r.createdAt).toLocaleString() + " · " + (r.pages ? r.pages.length + " pages" : "all pages") + " · " + r.state.replace(/_/g, " "),
    status: failed ? "Failed" : ready ? "Indexed" : "Processing",
    pages: r.pages?.length ?? null,
    steps: WORK.map(([s, label], i) => ({ key: s, label, state: ready || i < at ? "done" : i === at ? (failed ? "failed" : "running") : failed && at < 0 && i === WORK.findIndex(([x]) => x === r.currentStep) ? "failed" : "pending" })),
    ...(failed ? { error: "The backend run failed" + (r.currentStep ? " at " + r.currentStep : "") + (err ? ": " + err : "") + ". Resume it with POST /runs/" + r.runId + "/resume." } : {}),
  };
}
/** A backend refusal in plain words: the error code, its message, and any blockers it lists. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await fetch(API_URL + path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); }
  catch { throw new Error("Can't reach the backend API at " + API_URL + ". Check VITE_API_URL and that the API allows this origin (CORS)."); }
  const body = await r.json().catch(() => null) as (T & { error?: string; message?: string; issues?: unknown[]; blockers?: { message?: string }[] }) | null;
  if (!r.ok) {
    const extra = [...(body?.issues ?? []).map(String), ...(body?.blockers ?? []).map(b => b.message ?? "")].filter(Boolean);
    throw new Error((body?.message || body?.error || "Backend returned " + r.status) + " (" + path + ")" + (extra.length ? ": " + extra.join(" | ") : ""));
  }
  return body as T;
}

export const ACCEPT = ".pdf,.doc,.docx,.odt,.rtf,.xlsx,.xls,.csv,.ods,.png,.jpg,.jpeg,.tif,.tiff,.webp,.html,.htm,.txt,.md";
const TYPE_BY_EXT: Record<string, GuidelineType> = {
  pdf: "PDF", doc: "Word", docx: "Word", odt: "Word", rtf: "Word",
  xlsx: "Spreadsheet", xls: "Spreadsheet", csv: "Spreadsheet", ods: "Spreadsheet",
  png: "Image", jpg: "Image", jpeg: "Image", tif: "Image", tiff: "Image", webp: "Image",
  html: "Web or text", htm: "Web or text", txt: "Web or text", md: "Web or text",
};

/* ---------- In-memory store (sample data) ---------- */
let guidelines: Guideline[] = [
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
    // pages omitted: the backend reads every page. The presigned URL is signed for application/pdf.
    const r = await call<{ runId: string; uploadUrl: string }>("/runs", { method: "POST", body: JSON.stringify({ filename: file.name }) });
    nameRun(r.runId, file.name);
    await putFile(r.uploadUrl, file, { "Content-Type": "application/pdf" }, onProgress);
    return toGuideline({ runId: r.runId, state: "created", createdAt: Date.now() });
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
export const listGuidelines = async (): Promise<Guideline[]> => (LIVE ? (await call<Run[]>("/runs")).map(r => toGuideline(r)).reverse() : respond(guidelines));
export const getGuideline = async (id: string): Promise<Guideline> => {
  if (!LIVE) return respond(guidelines.find(g => g.id === id)!);
  const r = await call<{ run: Run; steps: StepRecord[] }>("/runs/" + id);
  return toGuideline(r.run, r.steps);
};

/* ---------- Workflow ---------- */
export async function createDraft(args: { guidelineId: string; pathway: string; pages: number[] }): Promise<Workflow> {
  const id = "wf-" + seq++;
  if (LIVE) {
    const g = await getGuideline(args.guidelineId);
    const vs = await call<VersionRec[]>("/runs/" + g.id + "/versions");
    const last = vs[vs.length - 1];
    if (!last) throw new Error("This run has no logic model version yet. Wait for the pipeline to finish.");
    const v = await call<{ body: unknown }>("/runs/" + g.id + "/versions/" + last.n);
    const model = loadSpec(v.body, "The backend's logic model (version " + last.n + ")");
    const [fc, fo] = await Promise.all(["clinician", "program_officer"].map(a => call<FindingsView>("/runs/" + g.id + "/versions/" + last.n + "/findings?audience=" + a)));
    const flat = (f: FindingsView, role: "clinician" | "program_officer") => f.groups.flatMap(gr => gr.findings.map(x => ({ severity: gr.severity, message: x.message, check: x.check, role })));
    const remote = { runId: g.id, n: last.n, modelSha: fc.modelSha, base: clone(model), claimText: fc.claimText, findings: [...flat(fc, "clinician"), ...flat(fo, "program_officer")] };
    const evidence = { pages: null, pagesFrom: "Guideline text stays in the backend; its own quote check is in the backend findings", draftB: null, draftBFrom: "The backend does not return a second draft" };
    workflows[id] = wf.createDraft(wf.initialWorkflow(id), { id: g.id, name: g.name, pathway: args.pathway, pages: args.pages }, {
      model, evidence, remote,
      event: "Loaded logic model version " + last.n + " from the backend (run " + g.id + ")",
      note: "modelSha " + fc.modelSha.slice(0, 12) + " · " + fc.claimText,
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
export const undo = (id: string) => mutate(id, wf.undoEdit);
export const chat = (id: string, text: string) => mutate(id, w => wf.chat(w, text));
export const applyProposal = (id: string, msgId: number, i: number) => mutate(id, w => wf.applyProposal(w, msgId, i));
export const dismissProposal = (id: string, msgId: number) => mutate(id, w => wf.dismissProposal(w, msgId));
export const answer = (id: string, flagId: string, choice: "keep" | "change") => mutate(id, w => wf.answerFlag(w, flagId, choice));
export async function approve(id: string): Promise<Workflow> {
  const w = load(id);
  if (!LIVE || !w.remote) return mutate(id, x => wf.approveAll(x));
  wf.approveAll(w); // the same local gate first: no blocking checks, every question answered
  const locked = await signOnBackend(w);
  return mutate(id, x => wf.approveAll(x, locked));
}

/** Save and sign on the backend. Each open question must be answered in a version saved by the role it is routed to,
    so questions routed to the program officer are answered first in a version the AI agent saves in that role. */
async function signOnBackend(w: Workflow): Promise<{ n: number; modelSha: string }> {
  const r = w.remote!, base = "/runs/" + r.runId;
  const vs = await call<VersionRec[]>(base + "/versions");
  let n = vs[vs.length - 1].n;
  const latest = (await call<{ body: Spec }>(base + "/versions/" + n)).body;
  const save = async (body: Spec, author: string, authorRole: "program_officer" | "clinician", note: string) => {
    const b: Spec = { ...body, meta: { ...body.meta, version: n + 1, parent_version: n, created_at: new Date().toISOString(), created_by: author, change_note: note } };
    const res = await call<{ n: number; checks_status: string }>(base + "/versions", { method: "POST", body: JSON.stringify({ parentVersion: n, body: b, author, authorRole }) });
    n = res.n;
  };
  const answer = (q: Spec["open_questions"][number]) => w.model.open_questions.find(x => x.id === q.id);
  const forOfficer = latest.open_questions.filter(q => q.route_to === "program_officer" && q.status === "open" && answer(q)?.status === "resolved");
  if (forOfficer.length) {
    const body: Spec = { ...latest, open_questions: latest.open_questions.map(q => (forOfficer.includes(q) ? { ...q, status: "resolved", resolution: answer(q)!.resolution } : q)) };
    await save(body, AGENT_ID, "program_officer", "AI agent recorded the answers to the program officer questions " + forOfficer.map(q => q.id).join(", ") + ", as the clinician confirmed them in review.");
  }
  const edits = w.versions.filter(v => v.event.startsWith("Edited")).length;
  await save(w.model, CLINICIAN_ID, "clinician", "Clinician review in the app: " + edits + " edit" + (edits === 1 ? "" : "s") + " to the rules, open questions answered, checks reviewed.");
  const st = await call<StatusView>(base + "/versions/" + n + "/status");
  const sign = (role: "program_officer" | "clinician", userId: string) =>
    call(base + "/versions/" + n + "/signatures/" + role, { method: "POST", body: JSON.stringify({ role, userId, modelSha: st.modelSha }) });
  await sign("program_officer", AGENT_ID);
  await sign("clinician", CLINICIAN_ID);
  return { n, modelSha: st.modelSha };
}
export const runVerify = (id: string) => mutate(id, wf.runVerify);
export const approveDeploy = (id: string) => mutate(id, wf.approveDeploy);
export const getAudit = async (id: string): Promise<AuditRow[]> => respond(load(id).audit);
