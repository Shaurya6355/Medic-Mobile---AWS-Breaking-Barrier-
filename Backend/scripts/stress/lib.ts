// Shared helpers for the end-to-end stress test (scripts/stress/run.ts). Talks to a running backend over HTTP only.
import { readFileSync, writeFileSync } from "node:fs";

export type Status = "pass" | "fail" | "finding" | "info";
export interface Result {
  id: string;
  area: string;
  name: string;
  status: Status;
  expected: string;
  actual: string;
  ms: number;
}

export const results: Result[] = [];
let seq = 0;

export const BASE = process.env["BASE"] ?? "http://localhost:8080";
export const PDF = process.env["PDF"] ?? "../Guideline_Docs/Cough_Guideline.pdf";
export const J = { "content-type": "application/json" };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Resp {
  status: number;
  body: any;
  ms: number;
  text: string;
}

export async function http(method: string, path: string, body?: unknown, opts: { raw?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Resp> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: opts.headers ?? (body !== undefined || opts.raw !== undefined ? J : {}),
      body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: ctl.signal,
    });
    const text = await r.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed, ms: Date.now() - t0, text };
  } catch (e) {
    return { status: 0, body: null, ms: Date.now() - t0, text: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Record one check. `ok` true = pass; false = fail (a defect against the contract); "finding" = works but is a risk. */
export function record(area: string, name: string, expected: string, actual: string, ok: boolean | "finding" | "info", ms = 0): Result {
  const r: Result = { id: `${area}-${String(++seq).padStart(2, "0")}`, area, name, status: ok === true ? "pass" : ok === false ? "fail" : ok, expected, actual, ms };
  results.push(r);
  const mark = { pass: "PASS   ", fail: "FAIL   ", finding: "FINDING", info: "INFO   " }[r.status];
  console.log(`${mark} ${r.id} ${name}${r.status === "pass" ? "" : `\n          expected: ${expected}\n          actual:   ${actual}`}`);
  return r;
}

export const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export async function createRun(name = "Cough_Guideline.pdf"): Promise<{ runId: string; uploadMs: number }> {
  const t0 = Date.now();
  const r = await http("POST", "/runs", { filename: name });
  if (r.status !== 201) throw new Error(`createRun ${r.status} ${r.text}`);
  const pdf = readFileSync(PDF);
  const up = await fetch(r.body.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdf });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  return { runId: r.body.runId, uploadMs: Date.now() - t0 };
}

export async function getRun(runId: string): Promise<{ run: any; steps: any[] }> {
  return (await http("GET", `/runs/${runId}`)).body;
}

export async function waitState(runId: string, states: string[], timeoutMs = 120_000): Promise<{ state: string; ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const s = (await getRun(runId))?.run?.state ?? "unknown";
    if (states.includes(s) || s === "failed") return { state: s, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { state: `timeout(${s})`, ms: Date.now() - t0 };
    await sleep(1000);
  }
}

/** Wait until the officer agent has finished with the run's newest version (signed or escalated) and nothing new arrives. */
export async function waitAgentSettled(runId: string, timeoutMs = 150_000): Promise<string> {
  const t0 = Date.now();
  let lastSeq = -1;
  let stableSince = Date.now();
  for (;;) {
    const a = await http("GET", `/runs/${runId}/activity`);
    const items: any[] = a.body?.items ?? [];
    const last = items[items.length - 1];
    if (last && last.seq !== lastSeq) {
      lastSeq = last.seq;
      stableSince = Date.now();
    }
    const done = last && /agent_escalated|agent_signed/.test(String(last.kind));
    if (done && Date.now() - stableSince > 4000) return String(last.kind);
    if (Date.now() - t0 > timeoutMs) return `timeout(${last?.kind})`;
    await sleep(1500);
  }
}

export async function latest(runId: string): Promise<{ n: number; body: any }> {
  const vs = (await http("GET", `/runs/${runId}/versions`)).body as { n: number }[];
  const n = vs[vs.length - 1]!.n;
  const v = await http("GET", `/runs/${runId}/versions/${n}`);
  return { n, body: v.body.body };
}

/** A new version body derived from `body`, as the frontend builds it. */
export function derive(body: any, parent: number, note: string, who = "stress-clinician"): any {
  return { ...body, meta: { ...body.meta, version: parent + 1, parent_version: parent, created_at: new Date().toISOString(), created_by: who, change_note: note } };
}

export function save(runId: string, parent: number, body: any, author = "stress-clinician", authorRole: string | undefined = "clinician"): Promise<Resp> {
  return http("POST", `/runs/${runId}/versions`, { parentVersion: parent, body, author, ...(authorRole ? { authorRole } : {}) });
}

export const chatReq = (runId: string, text: string, userId = "stress-clinician") =>
  http("POST", `/runs/${runId}/chat`, { userId, role: "clinician", messages: [{ from: "user", text }] });

export function writeResults(file: string, meta: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify({ meta, results }, null, 2));
}
