/**
 * Compiler settings live OUTSIDE the logic model (a separate settings JSON): they are
 * deployment choices (form title, icon, team default for the task window, contact types),
 * not clinical content, and they do not enter modelSha.
 */
import type { Origin } from "../logic/schema.js";

export interface CompileSettings {
  formTitle: string;
  /** CHT icon id, e.g. "icon-healthcare". */
  icon: string;
  /** Team default for a scheduled follow-up whose task_window_days_after_due is null. */
  taskWindowDays?: number | undefined;
  contactTypes: { person: boolean; place: boolean };
  /**
   * Which questions the form asks (default "minimal"):
   * - "full": every question its authored shown_when allows (no derived flow);
   * - "minimal": only questions that can still change the outcome (deriveFlow);
   * - "danger_signs_always": minimal, but every danger-sign question is always asked.
   */
  flowMode?: FlowMode | undefined;
}

export type FlowMode = "full" | "minimal" | "danger_signs_always";
export const FLOW_MODES: readonly FlowMode[] = ["full", "minimal", "danger_signs_always"];

/** Flow facts recorded in the manifest and README. Reproducible from modelSha + mode + derivationVersion. */
export interface FlowSummary {
  mode: FlowMode;
  derivationVersion: string;
  /** null for mode "full" (no tree). */
  nodes: number | null;
  leaves: number | null;
  maxDepth: number | null;
  questionsAlwaysAsked: string[];
  questionsSometimesSkipped: string[];
  neverAsked: string[];
  /** Grid points of enumerateAnswers(model) used for the averages and the verification. */
  points: number;
  /** Average questions shown by the compiled relevance, per grid point. */
  avgQuestions: number;
  /** Average questions with authored shown_when only. */
  avgQuestionsFullForm: number;
  treeMismatches: number;
  compiledMismatches: number;
  sequenceDifferences: number;
}

export type BuildKind = "preview" | "release";

export interface NotCompiled {
  item: string;
  reason: string;
}

export interface SourceRef {
  page: number;
  quote: string;
}

export interface SourcemapEntry {
  /** "survey" rows are 1-based worksheet row numbers (row 1 is the header). */
  target: { file: string; sheet?: string; row?: number; name: string };
  kind: "question" | "derived" | "outcome_calc" | "rule" | "outcome_note" | "dose_note" | "task";
  item: string;
  /** Present on question rows (and their page group) whose relevant includes a derived-flow condition. */
  flowCondition?: FlowMode;
  origin: Origin;
  sources: SourceRef[];
}

export interface Sourcemap {
  formId: string;
  modelSha: string;
  flowMode: FlowMode;
  entries: SourcemapEntry[];
}

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  files: ManifestFile[];
  formId: string;
  modelSha: string;
  buildKind: BuildKind;
  version: string;
  warnings: string[];
  notCompiled: NotCompiled[];
  flow: FlowSummary;
  sourcemap: Sourcemap;
}

export interface ReadinessResult {
  compile_ready: boolean;
  missing: string[];
  warnings: string[];
  notCompiled: NotCompiled[];
  /** Resolved window (days after due) per compiled scheduled outcome. */
  taskWindows: Record<string, number>;
}

export class CompileError extends Error {
  readonly result: ReadinessResult;
  constructor(message: string, result: ReadinessResult) {
    super(message);
    this.name = "CompileError";
    this.result = result;
  }
}
