/**
 * The derived question flow for the compiler (T11b).
 *
 * The flow is NOT part of the signed model: it is derived from it at compile time by deriveFlow
 * (src/logic/flow.ts), deterministically, so it is reproducible from modelSha + flowMode +
 * FLOW_DERIVATION_VERSION. Before a form is emitted, verifyFlow checks every point of the exact
 * answer grid: the form that shows only the flow's questions (others blank) must give the same
 * outcome as answering everything. Any mismatch, or a flow too large to derive, refuses the compile.
 */
import {
  deriveFlow,
  enumerateAnswers,
  FLOW_DERIVATION_VERSION,
  FlowTooLargeError,
  verifyFlow,
  type Flow,
  type FlowOptions,
  type FlowVerification,
  type Model,
} from "../logic/index.js";
import { CompileError, type FlowMode, type FlowSummary, type ReadinessResult } from "./types.js";

export interface FlowLimits {
  maxNodes?: number | undefined;
  maxStates?: number | undefined;
}

export interface PreparedFlow {
  mode: FlowMode;
  /** null for mode "full". */
  flow: Flow | null;
  summary: FlowSummary;
}

/** deriveFlow options per mode; null = no derived flow (authored shown_when only). */
export function flowOptionsFor(mode: FlowMode): FlowOptions | null {
  if (mode === "full") return null;
  if (mode === "minimal") return {};
  return { askAllDangerSigns: true };
}

function refusal(message: string): CompileError {
  const result: ReadinessResult = { compile_ready: false, missing: [message], warnings: [], notCompiled: [], taskWindows: {} };
  return new CompileError(message, result);
}

/** Runs verifyFlow and throws a CompileError if the tree or the compiled relevance gives any different outcome. */
export function assertFlowVerified(model: Model, flow: Flow, mode: FlowMode): FlowVerification {
  const v = verifyFlow(model, flow);
  if (v.mismatchCount > 0 || v.compiled.mismatchCount > 0) {
    const ex = v.compiled.mismatches[0] ?? v.mismatches[0];
    const detail = ex ? `; first: answers ${JSON.stringify(ex.answers)} expected ${ex.expected} got ${ex.got}` : "";
    throw refusal(
      `flow verification failed for flowMode ${mode}: ${v.mismatchCount} tree and ${v.compiled.mismatchCount} compiled mismatches over ${v.points} grid points${detail}`,
    );
  }
  return v;
}

export function prepareFlow(model: Model, mode: FlowMode, limits: FlowLimits = {}): PreparedFlow {
  const opts = flowOptionsFor(mode);
  if (opts === null) {
    const grid = enumerateAnswers(model);
    const N = grid.points.length || 1;
    const full = grid.points.reduce((a, p) => a + Object.keys(p).length, 0) / N;
    return {
      mode,
      flow: null,
      summary: {
        mode,
        derivationVersion: FLOW_DERIVATION_VERSION,
        nodes: null,
        leaves: null,
        maxDepth: null,
        questionsAlwaysAsked: [],
        questionsSometimesSkipped: [],
        neverAsked: [],
        points: grid.points.length,
        avgQuestions: full,
        avgQuestionsFullForm: full,
        treeMismatches: 0,
        compiledMismatches: 0,
        sequenceDifferences: 0,
      },
    };
  }
  let flow: Flow;
  try {
    flow = deriveFlow(model, { ...opts, ...(limits.maxNodes !== undefined ? { maxNodes: limits.maxNodes } : {}), ...(limits.maxStates !== undefined ? { maxStates: limits.maxStates } : {}) });
  } catch (e) {
    if (e instanceof FlowTooLargeError) throw refusal(`the question flow is too large (flowMode ${mode}): ${e.message}`);
    throw e;
  }
  const v = assertFlowVerified(model, flow, mode);
  return {
    mode,
    flow,
    summary: {
      mode,
      derivationVersion: FLOW_DERIVATION_VERSION,
      nodes: flow.stats.nodes,
      leaves: flow.stats.leaves,
      maxDepth: flow.stats.maxDepth,
      questionsAlwaysAsked: flow.stats.questionsAlwaysAsked,
      questionsSometimesSkipped: flow.stats.questionsSometimesSkipped,
      neverAsked: flow.stats.neverAsked,
      points: v.points,
      avgQuestions: v.compiled.avgQuestions,
      avgQuestionsFullForm: v.avgQuestionsFullForm,
      treeMismatches: v.mismatchCount,
      compiledMismatches: v.compiled.mismatchCount,
      sequenceDifferences: v.compiled.sequenceDifferences,
    },
  };
}
