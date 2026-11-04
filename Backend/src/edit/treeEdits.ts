import { parseModel, type Condition, type Model } from "../logic/index.js";

/** The closed v1 set of tree edits. Everything else is refused as unsupported_edit. */
export type TreeEdit =
  | { op: "setQuestionLabel"; questionId: string; text: string }
  /** Moves one cut-off of a range region: every `at_least`/`less_than` on questionId equal to `from` in the rule (or the derived values it reads) becomes `to`. */
  | { op: "setThreshold"; questionId: string; ruleId: string; from: number; to: number }
  /** field "title" = the outcome title; "action" = the text of actions[actionIndex ?? 0] (instructions, referral text). */
  | { op: "setOutcomeText"; ruleId: string; field: "title" | "action"; actionIndex?: number; text: string }
  | { op: "setFollowUpDays"; ruleId: string; days: number };

export type TreeEditResult =
  | { ok: true; model: Model; paths: string[] }
  | { ok: false; code: "unsupported_edit" | "invalid_edit"; reason: string };

const OPS = ["setQuestionLabel", "setThreshold", "setOutcomeText", "setFollowUpDays"];
const bad = (reason: string): TreeEditResult => ({ ok: false, code: "invalid_edit", reason });

/** Replaces matching threshold atoms in c (mutating); returns the paths changed. */
function moveThreshold(c: Condition, base: string, field: string, from: number, to: number, out: string[]): void {
  if ("field" in c) {
    if (c.op !== "is_yes" && c.field === field && c.value === from) {
      c.value = to;
      out.push(`${base}.value`);
    }
    return;
  }
  const kids = "all" in c ? c.all : c.any;
  const key = "all" in c ? "all" : "any";
  kids.forEach((k, i) => moveThreshold(k, `${base}.${key}[${i}]`, field, from, to, out));
}

/** The derived ids a condition reads through is_yes, in first-seen order. */
function derivedReads(c: Condition, derivedIds: Set<string>, out: string[]): void {
  if ("field" in c) {
    if (c.op === "is_yes" && derivedIds.has(c.field) && !out.includes(c.field)) out.push(c.field);
    return;
  }
  for (const k of "all" in c ? c.all : c.any) derivedReads(k, derivedIds, out);
}

function applyOne(m: Model, e: TreeEdit): string[] | string {
  switch (e.op) {
    case "setQuestionLabel": {
      const i = m.questions.findIndex((q) => q.id === e.questionId);
      if (i < 0) return `no question "${e.questionId}"`;
      if (typeof e.text !== "string" || e.text.trim() === "") return "label text must not be empty";
      m.questions[i]!.label = e.text;
      return [`questions[${i}].label`];
    }
    case "setThreshold": {
      const ri = m.rules.findIndex((r) => r.id === e.ruleId);
      if (ri < 0) return `no rule "${e.ruleId}"`;
      const q = m.questions.find((x) => x.id === e.questionId);
      if (!q) return `no question "${e.questionId}"`;
      if (q.answer_type !== "integer") return `question "${e.questionId}" is not a number question`;
      if (!Number.isFinite(e.from) || !Number.isFinite(e.to)) return "from and to must be numbers";
      const rule = m.rules[ri]!;
      if (rule.when === "otherwise") return `rule "${e.ruleId}" has no condition`;
      const paths: string[] = [];
      moveThreshold(rule.when, `rules[${ri}].when`, e.questionId, e.from, e.to, paths);
      // Cut-offs usually live in a derived value the rule reads (transitively).
      const dIds = new Set(m.derived.map((d) => d.id));
      const queue: string[] = [];
      derivedReads(rule.when, dIds, queue);
      const seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const di = m.derived.findIndex((d) => d.id === id);
        moveThreshold(m.derived[di]!.definition, `derived[${di}].definition`, e.questionId, e.from, e.to, paths);
        derivedReads(m.derived[di]!.definition, dIds, queue);
      }
      if (paths.length === 0) return `rule "${e.ruleId}" has no cut-off ${e.from} on "${e.questionId}"`;
      return paths;
    }
    case "setOutcomeText": {
      const rule = m.rules.find((r) => r.id === e.ruleId);
      if (!rule) return `no rule "${e.ruleId}"`;
      const oi = m.outcomes.findIndex((o) => o.id === rule.outcome);
      if (oi < 0) return `rule "${e.ruleId}" points at unknown outcome`;
      if (typeof e.text !== "string" || e.text.trim() === "") return "text must not be empty";
      const o = m.outcomes[oi]!;
      if (e.field === "title") {
        o.title = e.text;
        return [`outcomes[${oi}].title`];
      }
      if (e.field === "action") {
        const ai = e.actionIndex ?? 0;
        if (!Number.isInteger(ai) || ai < 0 || ai >= o.actions.length) return `outcome has no action ${ai}`;
        o.actions[ai]!.text = e.text;
        return [`outcomes[${oi}].actions[${ai}].text`];
      }
      return `unknown outcome field "${String((e as { field: unknown }).field)}"`;
    }
    case "setFollowUpDays": {
      const rule = m.rules.find((r) => r.id === e.ruleId);
      if (!rule) return `no rule "${e.ruleId}"`;
      const oi = m.outcomes.findIndex((o) => o.id === rule.outcome);
      const o = oi < 0 ? undefined : m.outcomes[oi]!;
      if (!o || o.follow_up === null) return `outcome of rule "${e.ruleId}" has no follow-up`;
      if (!Number.isInteger(e.days) || e.days < 0 || e.days > 3650) return "days must be a whole number from 0 to 3650";
      o.follow_up.due_in_days = e.days;
      return [`outcomes[${oi}].follow_up.due_in_days`];
    }
  }
}

/** Applies edits to a copy. Never mutates the input; meta (version, parent_version) is left to the save step. */
export function applyTreeEdits(model: Model, edits: readonly TreeEdit[]): TreeEditResult {
  if (!Array.isArray(edits) || edits.length === 0) return bad("no edits given");
  for (const e of edits) {
    if (typeof e !== "object" || e === null || !OPS.includes((e as { op?: string }).op ?? "")) {
      return { ok: false, code: "unsupported_edit", reason: `edit "${String((e as { op?: unknown } | null)?.op)}" is not supported; only ${OPS.join(", ")}` };
    }
  }
  const copy = structuredClone(model);
  const paths: string[] = [];
  for (const e of edits) {
    const r = applyOne(copy, e);
    if (typeof r === "string") return bad(r);
    for (const p of r) if (!paths.includes(p)) paths.push(p);
  }
  const parsed = parseModel(copy);
  if (!parsed.ok) return bad(`edited model is not valid: ${parsed.issues.slice(0, 3).join("; ")}`);
  return { ok: true, model: parsed.value, paths };
}
