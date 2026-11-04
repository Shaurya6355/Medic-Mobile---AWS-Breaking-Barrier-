import { z } from "zod";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { deriveFlow, evaluate, walkFlow as walkTree, type Answers, type Model } from "../logic/index.js";
import type { Signoff } from "../signoff/signoff.js";
import { loadVersion } from "../signoff/checks.js";
import type { Store } from "../store/store.js";
import { retrieve } from "./retrieve.js";

export const ToolCall = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("searchGuideline"), query: z.string().min(1).max(500) }),
  z.strictObject({ tool: z.literal("runStatus") }),
  z.strictObject({ tool: z.literal("runCost") }),
  z.strictObject({ tool: z.literal("walkFlow"), answers: z.record(z.string(), z.union([z.number(), z.boolean()])) }),
  z.strictObject({ tool: z.literal("explainFinding"), code: z.string().max(100).optional() }),
  z.strictObject({ tool: z.literal("diffVersions"), a: z.number().int().min(1), b: z.number().int().min(1) }),
  z.strictObject({ tool: z.literal("listActivity"), limit: z.number().int().min(1).max(30).optional() }),
]);
export type ToolCall = z.infer<typeof ToolCall>;

export interface ToolDeps {
  store: Store;
  artifacts: ArtifactStore;
  signoff: Signoff;
}

export interface ToolResult {
  tool: string;
  /** Plain text handed to the model as data. */
  text: string;
  /** Machine-readable result (tests, UI). */
  data?: unknown;
}

const latestN = async (store: Store, runId: string): Promise<number | undefined> => {
  const vs = await store.listVersions(runId);
  return vs.length === 0 ? undefined : Math.max(...vs.map((v) => v.n));
};

async function modelOf(deps: ToolDeps, runId: string, n: number): Promise<Model | undefined> {
  return (await loadVersion(deps, runId, n)).model;
}

export function diffObjects(a: unknown, b: unknown, path = "", out: string[] = [], cap = 40): string[] {
  if (out.length >= cap) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffObjects(a[k], b[k], path === "" ? k : `${path}.${k}`, out, cap);
    return out;
  }
  const show = (x: unknown) => (x === undefined ? "(absent)" : JSON.stringify(x).slice(0, 120));
  out.push(`${path}: ${show(a)} -> ${show(b)}`);
  return out;
}

export async function runTool(deps: ToolDeps, runId: string, call: ToolCall): Promise<ToolResult> {
  const { store, signoff, artifacts } = deps;
  const run = await store.getRun(runId);
  if (!run) return { tool: call.tool, text: "Run not found." };
  switch (call.tool) {
    case "searchGuideline": {
      const hits = await retrieve(artifacts, runId, call.query, 5);
      const data = hits.map((h) => ({ page: h.page, blockId: h.blockId, text: h.text }));
      return { tool: call.tool, data, text: hits.length === 0 ? "No matching passages." : hits.map((h) => `[page ${h.page}] ${h.text}`).join("\n") };
    }
    case "runStatus": {
      const n = await latestN(store, runId);
      if (n === undefined) return { tool: call.tool, text: `Run state: ${run.state}. No versions yet.`, data: { runState: run.state } };
      const s = await signoff.status(runId, n);
      const data = { runState: s.runState, version: n, status: s.status, gates: s.gates, nextStep: s.nextStep, checksNotRun: s.checksNotRun, validSignatures: s.validSignatures.map((x) => ({ role: x.role, userId: x.userId })) };
      return { tool: call.tool, data, text: JSON.stringify(data) };
    }
    case "runCost": {
      const steps = await store.listSteps(runId);
      const per = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number; latencyMs: number; unpriced: number }>();
      for (const s of steps) {
        const e = per.get(s.step) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, unpriced: 0 };
        e.costUsd += s.costUsd ?? 0;
        if (s.costUsd === undefined) e.unpriced += 1;
        e.inputTokens += s.inputTokens;
        e.outputTokens += s.outputTokens;
        e.latencyMs += s.latencyMs ?? 0;
        per.set(s.step, e);
      }
      const steps_ = Object.fromEntries(per);
      const total = [...per.values()].reduce((t, e) => ({ costUsd: t.costUsd + e.costUsd, inputTokens: t.inputTokens + e.inputTokens, outputTokens: t.outputTokens + e.outputTokens, latencyMs: t.latencyMs + e.latencyMs }), { costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
      const data = { steps: steps_, total };
      return { tool: call.tool, data, text: JSON.stringify(data) };
    }
    case "walkFlow": {
      const n = await latestN(store, runId);
      const model = n === undefined ? undefined : await modelOf(deps, runId, n);
      if (n === undefined || model === undefined) return { tool: call.tool, text: "No valid logic model to evaluate yet." };
      const answers = call.answers as Answers;
      try {
        const ev = evaluate(model, answers);
        let path: string[] | undefined;
        try {
          path = walkTree(deriveFlow(model), ev.effective).asked;
        } catch {
          path = undefined;
        }
        const outcome = model.outcomes.find((o) => o.id === ev.outcome);
        const data = { version: n, outcome: ev.outcome, title: (outcome as { title?: string } | undefined)?.title, rule: ev.rule, asked: path };
        return { tool: call.tool, data, text: JSON.stringify(data) };
      } catch (e) {
        return { tool: call.tool, data: { error: (e as Error).message }, text: `Cannot evaluate: ${(e as Error).message}` };
      }
    }
    case "explainFinding": {
      const n = await latestN(store, runId);
      if (n === undefined) return { tool: call.tool, text: "No versions yet." };
      const v = await signoff.findingsView(runId, n, "clinician");
      const groups = JSON.parse(JSON.stringify(v.groups)) as unknown;
      const data = { version: n, claimText: v.claimText, blocking: v.blocking, gates: v.gates, groups };
      let text = JSON.stringify(data);
      if (call.code !== undefined) text = `Filter: ${call.code}\n${text}`;
      return { tool: call.tool, data, text: text.slice(0, 6000) };
    }
    case "diffVersions": {
      const [ma, mb] = [await modelOf(deps, runId, call.a).catch(() => undefined), await modelOf(deps, runId, call.b).catch(() => undefined)];
      if (!ma || !mb) return { tool: call.tool, text: "One of the versions does not exist or is not a valid model." };
      const changes = diffObjects(ma, mb);
      return { tool: call.tool, data: { a: call.a, b: call.b, changes }, text: changes.length === 0 ? "No differences." : changes.join("\n") };
    }
    case "listActivity": {
      const ev = (await store.listAudit(runId)).slice(-(call.limit ?? 30));
      return { tool: call.tool, data: ev, text: ev.map((e) => `${e.at} ${e.type} ${JSON.stringify(e.detail).slice(0, 160)}`).join("\n") || "No activity." };
    }
  }
}
