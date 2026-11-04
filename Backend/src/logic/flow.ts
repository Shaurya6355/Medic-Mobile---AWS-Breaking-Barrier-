import { canonicalJson } from "./canonical.js";
import { enumerateAnswers } from "./grid.js";
import type { Answers, Value } from "./interpreter.js";
import { evalCondition, evaluate } from "./interpreter.js";
import type { Condition, Model, Question } from "./schema.js";
import { collectFieldRefs } from "./schema.js";

/**
 * Question flow derived from the rule table (T11a).
 *
 * The rule table stays the single source of truth. The flow is computed from it by code:
 * questions are taken in the model's order; a question is asked only while the outcome is not
 * yet decided. "Decided" means: over every way the remaining questions could still turn out
 * (each one answered with any value of its exact region set, OR left blank, while respecting
 * every authored shown_when), the interpreter gives one single outcome. Blank is included on
 * purpose: the compiled form leaves skipped questions blank, and the rules read blank as
 * "absent", so the decision has to hold for that case too. Then the short form and the full
 * answers always give the same outcome (verifyFlow checks this on every grid point).
 *
 * Pruning (default on): while the outcome is still open, a question is also skipped when every
 * answer to it and a blank answer lead to the identical rest of the flow; its answer then
 * cannot change what is asked next or the outcome. pruneIrrelevant: false gives the literal
 * "ask until decided" tree.
 *
 * Assumption: a question the flow asks is answered (all questions rules read are required,
 * DEC-016). A non-required question left blank after being asked is not branched on.
 *
 * Flow conditions (T11b, human ruling): the flow's relevance uses a FLOW-ONLY condition type,
 * FlowCondition = the model's atoms (is_yes, at_least, less_than, all, any) plus `is_no` (true only
 * when the answer is boolean false; blank or absent is false, never true), and the constant
 * "never" for a question no path asks. The signed model vocabulary is NOT changed: the flow is a
 * deterministic compile-time artefact derived from the model, reproducible from the model hash plus
 * the flow options and FLOW_DERIVATION_VERSION. With is_no every step of a path can be written, so
 * the compiled relevance shows exactly the questions the tree asks (verifyFlow counts any
 * difference in compiled.sequenceDifferences).
 */

/** Bumped whenever the derivation or the meaning of FlowCondition changes. */
export const FLOW_DERIVATION_VERSION = "flow-2-is_no";

export type FlowAtom =
  | { field: string; op: "is_yes" }
  | { field: string; op: "is_no" }
  | { field: string; op: "at_least" | "less_than"; value: number };
export type FlowCondition = FlowAtom | { all: FlowCondition[] } | { any: FlowCondition[] };
/** Relevance of one question: null = no restriction, "never" = never asked. */
export type FlowRelevance = FlowCondition | "never" | null;

/**
 * Evaluates a flow relevance on answers. Atoms read answers only (the flow references questions,
 * never derived values). Absent answers make every atom false, including is_no.
 */
export function evalFlowCondition(c: FlowRelevance, values: Answers): boolean {
  if (c === null) return true;
  if (c === "never") return false;
  if ("all" in c) return c.all.every((k) => evalFlowCondition(k, values));
  if ("any" in c) return c.any.some((k) => evalFlowCondition(k, values));
  const v = values[c.field];
  if (v === undefined) return false;
  if (c.op === "is_yes") return v === true;
  if (c.op === "is_no") return v === false;
  if (typeof v !== "number") return false;
  return c.op === "at_least" ? v >= c.value : v < c.value;
}

export type Region =
  | { kind: "yes" }
  | { kind: "no" }
  /** yes_no question whose yes and no answers lead to the same place. */
  | { kind: "any" }
  /** Integer interval [min, below); null means "no bound on that side" (the domain edge). */
  | { kind: "range"; min: number | null; below: number | null };

export type FlowLeaf = { leaf: string; rule: string };
export type FlowAsk = { ask: string; branches: Array<{ region: Region; next: FlowNode }> };
export type FlowNode = FlowAsk | FlowLeaf;

export interface FlowStats {
  nodes: number;
  leaves: number;
  /** Most questions asked on one path. */
  maxDepth: number;
  /** Asked on every path through the tree. */
  questionsAlwaysAsked: string[];
  /** Asked on some paths, not on others. */
  questionsSometimesSkipped: string[];
  /** Never asked on any path (their shownWhen entry is "never"). */
  neverAsked: string[];
}

export interface Flow {
  root: FlowNode;
  /**
   * Flow relevance per question (FlowCondition: model atoms plus is_no). null = no restriction
   * from the flow; "never" = no path asks it. Exactly the paths of the tree that ask the question.
   */
  shownWhen: Record<string, FlowCondition | "never" | null>;
  /** Questions that are never skipped by the flow (still subject to their own shown_when). */
  alwaysAsk: string[];
  stats: FlowStats;
}

export interface FlowOptions {
  /** Ask every question read by the derived value "danger_sign" (see dangerSignQuestions). */
  askAllDangerSigns?: boolean;
  /** Explicit question ids that are always asked when their own shown_when allows. */
  alwaysAsk?: string[];
  /**
   * Default true. Also skip a question while the outcome is still open when every answer to it,
   * and leaving it blank, lead to the identical rest of the flow (its answer cannot matter).
   * false = the literal rule: ask every question until the outcome is decided.
   */
  pruneIrrelevant?: boolean;
  /** Guard on tree size. Default 5000. */
  maxNodes?: number;
  /** Guard on the number of intermediate states explored. Default 2,000,000. */
  maxStates?: number;
}

export class FlowTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowTooLargeError";
  }
}

// ---------- regions ----------

interface QInfo {
  q: Question;
  /** Regions in ascending order with one representative value each. */
  regions: Array<{ region: Region; value: Value }>;
  lo: number | null;
  hi: number | null;
}

function thresholdsOf(model: Model): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const add = (c: Condition): void => {
    const stack: Condition[] = [c];
    while (stack.length) {
      const x = stack.pop() as Condition;
      if ("field" in x) {
        if (x.op !== "is_yes") {
          if (!out.has(x.field)) out.set(x.field, new Set());
          out.get(x.field)!.add(Math.ceil(x.value));
        }
      } else stack.push(...("all" in x ? x.all : x.any));
    }
  };
  for (const q of model.questions) if (q.shown_when) add(q.shown_when);
  for (const d of model.derived) add(d.definition);
  for (const r of model.rules) if (r.when !== "otherwise") add(r.when);
  return out;
}

/**
 * Same cut points as grid.ts candidates: every integer atom is constant between consecutive
 * cuts ceil(t), so one value per interval represents the whole interval exactly.
 */
function questionInfo(model: Model): QInfo[] {
  const th = thresholdsOf(model);
  return model.questions.map((q) => {
    if (q.answer_type === "yes_no") {
      return { q, lo: null, hi: null, regions: [{ region: { kind: "yes" }, value: true }, { region: { kind: "no" }, value: false }] };
    }
    const lo = q.constraint ? q.constraint.min : null;
    const hi = q.constraint ? q.constraint.max : null;
    const cuts = [...(th.get(q.id) ?? [])]
      .filter((c) => (lo === null || c > lo) && (hi === null || c <= hi))
      .sort((a, b) => a - b);
    const regions: QInfo["regions"] = [];
    const bounds: Array<number | null> = [null, ...cuts, null];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const min = bounds[i] as number | null;
      const below = bounds[i + 1] as number | null;
      const value = min !== null ? min : below !== null ? (lo !== null ? lo : below - 1) : lo !== null ? lo : 0;
      regions.push({ region: { kind: "range", min, below }, value });
    }
    return { q, lo, hi, regions };
  });
}

function inRegion(r: Region, v: Value | undefined): boolean {
  if (v === undefined) return false;
  if (r.kind === "yes") return v === true;
  if (r.kind === "no") return v === false;
  if (r.kind === "any") return typeof v === "boolean";
  if (typeof v !== "number") return false;
  return (r.min === null || v >= r.min) && (r.below === null || v < r.below);
}

function mergeRegions(a: Region, b: Region): Region {
  if (a.kind === "range" && b.kind === "range") return { kind: "range", min: a.min, below: b.below };
  return { kind: "any" };
}

// ---------- danger signs ----------

/**
 * Convention (no new vocabulary): if the model has a derived value whose id is "danger_sign",
 * every question it reads, directly or through other derived values, is a danger-sign
 * question. Returned in the model's question order. Empty when there is no such derived value.
 */
export function dangerSignQuestions(model: Model): string[] {
  const derived = new Map(model.derived.map((d) => [d.id, d]));
  if (!derived.has("danger_sign")) return [];
  const qids = new Set(model.questions.map((q) => q.id));
  const found = new Set<string>();
  const seen = new Set<string>();
  const stack = ["danger_sign"];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const f of collectFieldRefs(derived.get(id)!.definition)) {
      if (qids.has(f)) found.add(f);
      else if (derived.has(f)) stack.push(f);
    }
  }
  return model.questions.map((q) => q.id).filter((id) => found.has(id));
}

// ---------- derivation ----------

const MULTI = -1;

export function deriveFlow(model: Model, opts: FlowOptions = {}): Flow {
  const maxNodes = opts.maxNodes ?? 5000;
  const maxStates = opts.maxStates ?? 2_000_000;
  const prune = opts.pruneIrrelevant ?? true;
  const info = questionInfo(model);
  const qids = new Set(model.questions.map((q) => q.id));
  const always = new Set([...(opts.alwaysAsk ?? []), ...(opts.askAllDangerSigns ? dangerSignQuestions(model) : [])]);
  const alwaysAsk = model.questions.map((q) => q.id).filter((id) => always.has(id));
  const outcomeIndex = new Map(model.outcomes.map((o, i) => [o.id, i]));
  const n = info.length;

  // state[i] = value of question i, or undefined (blank / hidden / skipped)
  const toAnswers = (state: Array<Value | undefined>): Answers => {
    const a: Answers = {};
    state.forEach((v, i) => {
      if (v !== undefined) a[info[i]!.q.id] = v;
    });
    return a;
  };
  const shownByAuthor = (i: number, state: Array<Value | undefined>): boolean => {
    const sw = info[i]!.q.shown_when;
    return sw === undefined || evalCondition(sw, toAnswers(state), qids);
  };
  const keyOf = (i: number, state: Array<Value | undefined>): string =>
    `${i}|${state.map((v) => (v === undefined ? "_" : String(v))).join(",")}`;

  // Single outcome index over all completions from question i on, or MULTI.
  const memo = new Map<string, number>();
  const outcomeSet = (i: number, state: Array<Value | undefined>): number => {
    const key = keyOf(i, state);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (memo.size >= maxStates) {
      throw new FlowTooLargeError(`flow derivation explored more than ${maxStates} states; the model is too large to derive a flow`);
    }
    let result: number;
    if (i === n) {
      result = outcomeIndex.get(evaluate(model, toAnswers(state), { allowMissing: true }).outcome) as number;
    } else {
      const choices: Array<Value | undefined> = shownByAuthor(i, state)
        ? [...info[i]!.regions.map((r) => r.value), undefined]
        : [undefined];
      result = -2;
      for (const c of choices) {
        const r = outcomeSet(i + 1, [...state, c]);
        if (r === MULTI || (result !== -2 && r !== result)) {
          result = MULTI;
          break;
        }
        result = r;
      }
    }
    memo.set(key, result);
    return result;
  };

  let created = 0;
  const bump = (): void => {
    created++;
    if (created > maxNodes) {
      throw new FlowTooLargeError(`the derived flow has more than ${maxNodes} nodes; raise maxNodes or simplify the model`);
    }
  };
  const canon = new WeakMap<object, string>();
  const canonOf = (node: FlowNode): string => {
    let s = canon.get(node);
    if (s === undefined) {
      s = canonicalJson(node);
      canon.set(node, s);
    }
    return s;
  };

  const leafAt = (state: Array<Value | undefined>): FlowLeaf => {
    const full = [...state];
    while (full.length < n) full.push(undefined);
    const e = evaluate(model, toAnswers(full), { allowMissing: true });
    bump();
    return { leaf: e.outcome, rule: e.rule };
  };

  const built = new Map<string, FlowNode>();
  const build = (i: number, state: Array<Value | undefined>): FlowNode => {
    const key = keyOf(i, state);
    const hit = built.get(key);
    if (hit) return hit;
    const node = buildFresh(i, state);
    built.set(key, node);
    return node;
  };
  const buildFresh = (i: number, state: Array<Value | undefined>): FlowNode => {
    if (i === n) return leafAt(state);
    if (!shownByAuthor(i, state)) return build(i + 1, [...state, undefined]);
    const id = info[i]!.q.id;
    const decided = outcomeSet(i, state) !== MULTI;
    if (decided) {
      const pending = info.slice(i).some((x) => always.has(x.q.id));
      if (!pending) return leafAt(state);
      if (!always.has(id)) return build(i + 1, [...state, undefined]);
    }
    const branches: FlowAsk["branches"] = [];
    for (const r of info[i]!.regions) {
      const next = build(i + 1, [...state, r.value]);
      const last = branches[branches.length - 1];
      if (last && canonOf(last.next) === canonOf(next)) last.region = mergeRegions(last.region, r.region);
      else branches.push({ region: r.region, next });
    }
    // Pruning: every answer AND a blank answer lead to the identical rest of the flow, so the
    // answer cannot change what is asked next nor the outcome reached: do not ask it.
    if (prune && branches.length === 1 && !always.has(id)) {
      const blank = build(i + 1, [...state, undefined]);
      if (canonOf(blank) === canonOf(branches[0]!.next)) return blank;
    }
    bump();
    return { ask: id, branches };
  };

  const root = build(0, []);
  const stats = statsOf(root, model);
  const shownWhen = deriveShownWhen(root, model, info);
  return { root, shownWhen, alwaysAsk, stats };
}

function statsOf(root: FlowNode, model: Model): FlowStats {
  let nodes = 0;
  let leaves = 0;
  let maxDepth = 0;
  let paths = 0;
  const askedOnPaths = new Map<string, number>();
  const visit = (node: FlowNode, depth: number, onPath: string[]): void => {
    nodes++;
    if (!("ask" in node)) {
      leaves++;
      paths++;
      maxDepth = Math.max(maxDepth, depth);
      for (const id of new Set(onPath)) askedOnPaths.set(id, (askedOnPaths.get(id) ?? 0) + 1);
      return;
    }
    for (const b of node.branches) visit(b.next, depth + 1, [...onPath, node.ask]);
  };
  visit(root, 0, []);
  const ids = model.questions.map((q) => q.id);
  return {
    nodes,
    leaves,
    maxDepth,
    questionsAlwaysAsked: ids.filter((id) => askedOnPaths.get(id) === paths),
    questionsSometimesSkipped: ids.filter((id) => (askedOnPaths.get(id) ?? 0) > 0 && askedOnPaths.get(id)! < paths),
    neverAsked: ids.filter((id) => !askedOnPaths.has(id)),
  };
}

// ---------- shownWhen ----------

type Interval = { lo: number | null; hi: number | null }; // [lo, hi) with null = unbounded
type Constraint = "yes" | "no" | Interval;
type Term = Map<string, Constraint>; // conjunction; field -> constraint

function termKey(t: Term, order: Map<string, number>): string {
  return [...t.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .map(([f, c]) => `${f}:${typeof c === "string" ? c : `${c.lo ?? "-"}..${c.hi ?? "-"}`}`)
    .join("&");
}

/** a implies b, per field constraint. */
function implies(a: Constraint, b: Constraint): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  const loOk = b.lo === null || (a.lo !== null && a.lo >= b.lo);
  const hiOk = b.hi === null || (a.hi !== null && a.hi <= b.hi);
  return loOk && hiOk;
}

/** Term a is weaker than (implied by) term b: every constraint in a is implied by b's. */
function subsumes(a: Term, b: Term): boolean {
  for (const [f, c] of a) {
    const d = b.get(f);
    if (d === undefined || !implies(d, c)) return false;
  }
  return true;
}

function simplifyTerms(input: Term[], order: Map<string, number>): Term[] | null {
  let terms = input;
  for (;;) {
    if (terms.some((t) => t.size === 0)) return null;
    // dedupe and absorption
    const byKey = new Map<string, Term>();
    for (const t of terms) byKey.set(termKey(t, order), t);
    let list = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, t]) => t);
    list = list.filter((t, i) => !list.some((u, j) => j !== i && subsumes(u, t) && (!subsumes(t, u) || j < i)));
    // merge two terms that differ only in one integer field with touching intervals
    let merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.size !== b.size) continue;
        let diff: string | undefined;
        let ok = true;
        for (const [f, c] of a) {
          const d = b.get(f);
          if (d === undefined) {
            ok = false;
            break;
          }
          if (termKey(new Map([[f, c]]), order) === termKey(new Map([[f, d]]), order)) continue;
          if (diff !== undefined || (typeof c === "string") !== (typeof d === "string")) {
            ok = false;
            break;
          }
          diff = f;
        }
        if (!ok || diff === undefined) continue;
        if (typeof a.get(diff) === "string" || typeof b.get(diff) === "string") {
          // "yes" or "no" of an asked (required, hence answered) question: the field drops out.
          // Exact: the field is asked on both paths, whose earlier steps are in the shared rest.
          const t: Term = new Map(a);
          t.delete(diff);
          list = [...list.filter((_, k) => k !== i && k !== j), t];
          merged = true;
          break outer;
        }
        const x = a.get(diff) as Interval;
        const y = b.get(diff) as Interval;
        const [first, second] = x.lo === null || (y.lo !== null && x.lo <= y.lo) ? [x, y] : [y, x];
        const touches = first.hi === null || second.lo === null || first.hi >= second.lo;
        if (!touches) continue;
        const hi = first.hi === null || second.hi === null ? null : Math.max(first.hi, second.hi);
        const t: Term = new Map(a);
        if (first.lo === null && hi === null) t.delete(diff);
        else t.set(diff, { lo: first.lo, hi });
        list = [...list.filter((_, k) => k !== i && k !== j), t];
        merged = true;
        break outer;
      }
    }
    terms = list;
    if (!merged) {
      return terms.some((t) => t.size === 0) ? null : terms;
    }
  }
}

function atomsOf(t: Term, order: Map<string, number>): FlowCondition[] {
  const out: FlowCondition[] = [];
  const fields = [...t.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const f of fields) {
    const c = t.get(f)!;
    if (c === "yes") out.push({ field: f, op: "is_yes" });
    else if (c === "no") out.push({ field: f, op: "is_no" });
    else {
      if (c.lo !== null) out.push({ field: f, op: "at_least", value: c.lo });
      if (c.hi !== null) out.push({ field: f, op: "less_than", value: c.hi });
    }
  }
  return out;
}

const conj = (cs: FlowCondition[]): FlowCondition => (cs.length === 1 ? cs[0]! : { all: cs });

function termsToCondition(terms: Term[], order: Map<string, number>): FlowCondition {
  if (terms.length === 1) return conj(atomsOf(terms[0]!, order));
  // factor constraints common to every term, for readability
  const common: Term = new Map();
  for (const [f, c] of terms[0]!) {
    const k = termKey(new Map([[f, c]]), order);
    if (terms.every((t) => t.has(f) && termKey(new Map([[f, t.get(f)!]]), order) === k)) common.set(f, c);
  }
  const rest = terms.map((t) => {
    const r: Term = new Map(t);
    for (const f of common.keys()) r.delete(f);
    return r;
  });
  const anyPart: FlowCondition = { any: rest.map((r) => conj(atomsOf(r, order))) };
  return common.size === 0 ? anyPart : { all: [...atomsOf(common, order), anyPart] };
}

function regionConstraint(r: Region, info: QInfo): Constraint | undefined {
  if (r.kind === "yes") return "yes";
  if (r.kind === "no") return "no";
  if (r.kind === "any") return undefined; // yes or no: the question is asked (and answered) anyway
  const lo = r.min !== null && (info.lo === null || r.min > info.lo) ? r.min : null;
  const hi = r.below !== null && (info.hi === null || r.below <= info.hi) ? r.below : null;
  return lo === null && hi === null ? undefined : { lo, hi };
}

function deriveShownWhen(root: FlowNode, model: Model, infos: QInfo[]): Record<string, FlowCondition | "never" | null> {
  const byId = new Map(infos.map((x) => [x.q.id, x]));
  const order = new Map(model.questions.map((q) => [q.id, q.order]));
  const paths = new Map<string, Term[]>();
  const visit = (node: FlowNode, path: Term): void => {
    if (!("ask" in node)) return;
    if (!paths.has(node.ask)) paths.set(node.ask, []);
    paths.get(node.ask)!.push(path);
    for (const b of node.branches) {
      const c = regionConstraint(b.region, byId.get(node.ask)!);
      const next: Term = new Map(path);
      if (c !== undefined) next.set(node.ask, c);
      visit(b.next, next);
    }
  };
  visit(root, new Map());
  const out: Record<string, FlowCondition | "never" | null> = {};
  for (const q of model.questions) {
    const ts = paths.get(q.id);
    if (!ts) {
      out[q.id] = "never";
      continue;
    }
    const s = simplifyTerms(ts, order);
    out[q.id] = s === null ? null : termsToCondition(s, order);
  }
  return out;
}

/**
 * Relevance for the compiler: the question's authored shown_when AND the flow's shownWhen,
 * flattened, duplicates removed, conjuncts in question order. null = always shown, "never" = never.
 */
export function effectiveShownWhen(model: Model, flow: Flow, questionId: string): FlowRelevance {
  const q = model.questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`unknown question "${questionId}"`);
  const order = new Map(model.questions.map((x) => [x.id, x.order]));
  const fl = flow.shownWhen[questionId] ?? null;
  if (fl === "never") return "never";
  const parts: FlowCondition[] = [];
  const add = (c: FlowCondition | null | undefined): void => {
    if (!c) return;
    if ("all" in c) c.all.forEach(add);
    else parts.push(c);
  };
  add(q.shown_when);
  add(fl);
  const seen = new Set<string>();
  const uniq = parts.filter((c) => {
    const k = canonicalJson(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank = (c: FlowCondition): [number, number, number] => {
    if ("field" in c) {
      const op = c.op === "is_yes" ? 0 : c.op === "is_no" ? 1 : c.op === "at_least" ? 2 : 3;
      return [order.get(c.field) ?? Number.MAX_SAFE_INTEGER, op, "value" in c ? c.value : 0];
    }
    return [Number.MAX_SAFE_INTEGER, 4, 0];
  };
  uniq.sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  if (uniq.length === 0) return null;
  return conj(uniq);
}

// ---------- walking and verification ----------

export interface Walk {
  asked: string[];
  leaf: FlowLeaf;
}

/** Follow the tree with full answers. Throws if the tree asks something the answers lack or no branch fits. */
export function walkFlow(flow: Flow, answers: Answers): Walk {
  const asked: string[] = [];
  let node = flow.root;
  while ("ask" in node) {
    const v = answers[node.ask];
    const id = node.ask;
    const b = node.branches.find((x) => inRegion(x.region, v));
    if (!b) throw new Error(`the flow asks "${id}" but no branch fits the answer ${String(v)}`);
    asked.push(id);
    node = b.next;
  }
  return { asked, leaf: node };
}

export interface FlowMismatch {
  answers: Answers;
  shown: string[];
  expected: string;
  got: string;
}

export interface FlowVerification {
  points: number;
  mismatchCount: number;
  mismatches: FlowMismatch[];
  /** Number of questions asked (walking the tree) -> number of grid points. */
  questionsAskedHistogram: Record<number, number>;
  avgQuestions: number;
  /** Average number of questions the full form (authored shown_when only) asks. */
  avgQuestionsFullForm: number;
  avgQuestionsSaved: number;
  /** Same check using the compiled relevance (effectiveShownWhen) instead of the tree. */
  compiled: {
    mismatchCount: number;
    mismatches: FlowMismatch[];
    questionsAskedHistogram: Record<number, number>;
    avgQuestions: number;
    /** Grid points where the compiled relevance shows a different question sequence than the tree asks. */
    sequenceDifferences: number;
  };
}

/**
 * For every full-answer point of the exact grid: restrict the answers to the questions the flow
 * shows (skipped ones blank), evaluate, and compare with the outcome on the full answers.
 * Done twice: walking the tree, and with the compiled relevance (authored AND flow shownWhen).
 */
export function verifyFlow(model: Model, flow: Flow): FlowVerification {
  const grid = enumerateAnswers(model);
  const relevance = new Map(model.questions.map((q) => [q.id, effectiveShownWhen(model, flow, q.id)]));
  const tree = { count: 0, list: [] as FlowMismatch[], hist: {} as Record<number, number>, total: 0 };
  const comp = { count: 0, list: [] as FlowMismatch[], hist: {} as Record<number, number>, total: 0 };
  let fullTotal = 0;
  let sequenceDifferences = 0;

  const check = (acc: typeof tree, point: Answers, shown: string[], expected: string): void => {
    const form: Answers = {};
    for (const id of shown) if (point[id] !== undefined) form[id] = point[id];
    let got: string;
    try {
      got = evaluate(model, form, { allowMissing: true }).outcome;
    } catch (e) {
      got = `error: ${(e as Error).message}`;
    }
    acc.hist[shown.length] = (acc.hist[shown.length] ?? 0) + 1;
    acc.total += shown.length;
    if (got !== expected) {
      acc.count++;
      if (acc.list.length < 10) acc.list.push({ answers: point, shown, expected, got });
    }
  };

  for (const point of grid.points) {
    const expected = evaluate(model, point).outcome;
    fullTotal += Object.keys(point).length;
    let shown: string[] | undefined;
    try {
      shown = walkFlow(flow, point).asked;
    } catch (e) {
      // a tree that cannot be walked is a mismatch by definition
      tree.count++;
      if (tree.list.length < 10) tree.list.push({ answers: point, shown: [], expected, got: `error: ${(e as Error).message}` });
      tree.hist[0] = (tree.hist[0] ?? 0) + 1;
    }
    if (shown !== undefined) check(tree, point, shown, expected);

    const form: Answers = {};
    const compShown: string[] = [];
    for (const q of model.questions) {
      if (evalFlowCondition(relevance.get(q.id) ?? null, form)) {
        compShown.push(q.id);
        if (point[q.id] !== undefined) form[q.id] = point[q.id];
      }
    }
    check(comp, point, compShown, expected);
    if (shown === undefined || shown.join(",") !== compShown.join(",")) sequenceDifferences++;
  }
  const N = grid.points.length || 1;
  const avg = tree.total / N;
  const full = fullTotal / N;
  return {
    points: grid.points.length,
    mismatchCount: tree.count,
    mismatches: tree.list,
    questionsAskedHistogram: tree.hist,
    avgQuestions: avg,
    avgQuestionsFullForm: full,
    avgQuestionsSaved: full - avg,
    compiled: { mismatchCount: comp.count, mismatches: comp.list, questionsAskedHistogram: comp.hist, avgQuestions: comp.total / N, sequenceDifferences },
  };
}

// ---------- plain outputs ----------

function unitWord(q: Question): string {
  return q.unit ? ` ${q.unit.replace(/_/g, " ")}` : "";
}

/** Plain words for a region, e.g. "under 2 months", "2 to 11 months", "60 months or more", "yes". */
export function regionWords(region: Region, q: Question): string {
  if (region.kind === "yes") return "yes";
  if (region.kind === "no") return "no";
  if (region.kind === "any") return "any answer";
  const u = unitWord(q);
  const { min, below } = region;
  if (min === null && below === null) return "any answer";
  if (min === null) return `under ${below}${u}`;
  if (below === null) return `${min}${u} or more`;
  if (below - 1 === min) return `${min}${u}`;
  return `${min} to ${below - 1}${u}`;
}

const mm = (s: string): string => s.replace(/"/g, "#quot;");

/** Mermaid flowchart: question labels on nodes, plain answer words on edges, outcome titles on leaves. */
export function flowToMermaid(flow: Flow, model: Model): string {
  const qs = new Map(model.questions.map((q) => [q.id, q]));
  const titles = new Map(model.outcomes.map((o) => [o.id, o.title]));
  const lines = ["flowchart TD"];
  const leaves = new Set<string>();
  let next = 0;
  const visit = (node: FlowNode): string => {
    if (!("ask" in node)) {
      const id = `out_${node.leaf}`;
      if (!leaves.has(id)) {
        leaves.add(id);
        lines.push(`  ${id}(["${mm(titles.get(node.leaf) ?? node.leaf)}"])`);
      }
      return id;
    }
    const id = `q${next++}`;
    const q = qs.get(node.ask)!;
    lines.push(`  ${id}["${mm(q.label)}"]`);
    for (const b of node.branches) {
      const child = visit(b.next);
      lines.push(`  ${id} -- "${mm(regionWords(b.region, q))}" --> ${child}`);
    }
    return id;
  };
  visit(flow.root);
  return lines.join("\n");
}

/**
 * Plain sentences for a non-technical reviewer: one per way the form can end, plus a short
 * overview. Deterministic.
 */
export function describeFlow(flow: Flow, model: Model): string[] {
  const qs = new Map(model.questions.map((q) => [q.id, q]));
  const titles = new Map(model.outcomes.map((o) => [o.id, o.title]));
  const label = (id: string): string => `"${qs.get(id)!.label}"`;
  const end = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`);
  const out: string[] = [];
  if ("ask" in flow.root) out.push(`The form starts by asking ${label(flow.root.ask)}.`);
  if (flow.stats.questionsAlwaysAsked.length > 0) {
    out.push(`Always asked: ${flow.stats.questionsAlwaysAsked.map(label).join(", ")}.`);
  }
  if (flow.stats.questionsSometimesSkipped.length > 0) {
    out.push(`Asked only when the answer can still change the result: ${flow.stats.questionsSometimesSkipped.map(label).join(", ")}.`);
  }
  if (flow.alwaysAsk.length > 0) out.push(`Never skipped on purpose: ${flow.alwaysAsk.map(label).join(", ")}.`);

  for (const p of flowPaths(flow, model)) {
    const when = p.conds.length === 0 ? "In every case" : `If ${p.conds.join(", and ")}`;
    out.push(`${when}, the form ends: ${end(titles.get(p.leaf) ?? p.leaf)}`);
  }
  return out;
}

/** Every way the form can end: plain conditions on the path (branches leading to the same place joined with "or"). */
function flowPaths(flow: Flow, model: Model): Array<{ conds: string[]; leaf: string }> {
  const qs = new Map(model.questions.map((q) => [q.id, q]));
  const label = (id: string): string => `"${qs.get(id)!.label}"`;
  const out: Array<{ conds: string[]; leaf: string }> = [];
  const visit = (node: FlowNode, conds: string[]): void => {
    if (!("ask" in node)) {
      out.push({ conds, leaf: node.leaf });
      return;
    }
    const q = qs.get(node.ask)!;
    // group branches that lead to the same subtree, keep first-seen order
    const groups: Array<{ words: string[]; next: FlowNode; key: string }> = [];
    for (const b of node.branches) {
      const key = canonicalJson(b.next);
      const g = groups.find((x) => x.key === key);
      if (g) g.words.push(regionWords(b.region, q));
      else groups.push({ words: [regionWords(b.region, q)], next: b.next, key });
    }
    for (const g of groups) {
      const anyAnswer = g.words.length === 1 && g.words[0] === "any answer";
      visit(g.next, anyAnswer ? conds : [...conds, `${label(node.ask)} is ${g.words.join(" or ")}`]);
    }
  };
  visit(flow.root, []);
  return out;
}

/**
 * The same paths as describeFlow, grouped by outcome (model outcome order) for a reviewer:
 * `when` holds one plain condition list per path ("A is yes, and B is no"); "In every case" if none.
 */
export function describeFlowByOutcome(flow: Flow, model: Model): Array<{ outcome: string; title: string; when: string[] }> {
  const paths = flowPaths(flow, model);
  return model.outcomes
    .map((o) => ({
      outcome: o.id,
      title: o.title,
      when: paths.filter((p) => p.leaf === o.id).map((p) => (p.conds.length === 0 ? "In every case" : p.conds.join(", and "))),
    }))
    .filter((g) => g.when.length > 0);
}
