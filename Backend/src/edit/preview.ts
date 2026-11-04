import { canonicalJson, enumerateAnswers, evaluate, type Answers, type Flow, type Model } from "../logic/index.js";
import { describeFlowNodes, type FlowNodeInfo } from "./flowNodes.js";
import { applyTreeEdits, type TreeEdit } from "./treeEdits.js";

export interface BehaviourChange {
  answers: Answers;
  before: string;
  after: string;
}
export interface BehaviourChanges {
  /** Answer combinations whose outcome differs. */
  total: number;
  /** Combinations compared. */
  examined: number;
  exact: boolean;
  samples: BehaviourChange[];
}
export type BehaviourDiffFn = (before: Model, after: Model) => BehaviourChanges;

const MAX_SAMPLES = 50;

/** Compares outcomes of two models over the answer grid of both. */
export const simpleBehaviourDiff: BehaviourDiffFn = (before, after) => {
  const a = enumerateAnswers(before);
  const b = enumerateAnswers(after);
  const seen = new Set<string>();
  const samples: BehaviourChange[] = [];
  let total = 0;
  let examined = 0;
  const outcome = (m: Model, ans: Answers): string => {
    try {
      return evaluate(m, ans).outcome;
    } catch {
      return "(no result)";
    }
  };
  for (const p of [...a.points, ...b.points]) {
    const key = canonicalJson(p);
    if (seen.has(key)) continue;
    seen.add(key);
    examined++;
    const x = outcome(before, p);
    const y = outcome(after, p);
    if (x !== y) {
      total++;
      if (samples.length < MAX_SAMPLES) samples.push({ answers: p, before: x, after: y });
    }
  }
  return { total, examined, exact: a.exact && b.exact, samples };
};

export type PreviewResult =
  | { ok: true; model: Model; paths: string[]; flow: Flow; nodes: FlowNodeInfo[]; behaviourChanges: BehaviourChanges }
  | { ok: false; code: "unsupported_edit" | "invalid_edit"; reason: string };

/** Nothing is saved. Pass behaviourDiff to use another diff implementation. */
export function previewEdits(model: Model, edits: readonly TreeEdit[], behaviourDiff: BehaviourDiffFn = simpleBehaviourDiff): PreviewResult {
  const r = applyTreeEdits(model, edits);
  if (!r.ok) return r;
  const { flow, nodes } = describeFlowNodes(r.model);
  return { ok: true, model: r.model, paths: r.paths, flow, nodes, behaviourChanges: behaviourDiff(model, r.model) };
}
