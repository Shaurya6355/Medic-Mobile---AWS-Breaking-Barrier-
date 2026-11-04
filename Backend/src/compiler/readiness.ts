import type { Condition, Model } from "../logic/index.js";
import { FLOW_MODES, type CompileSettings, type NotCompiled, type ReadinessResult } from "./types.js";

export const ON_RETURN_REASON = "needs a return date (no trigger defined)";
/** Question id the compiler reads for dose_by_age bands. */
export const AGE_FIELD = "age_months";

/**
 * Decide whether the compiler has everything it needs. Lists EVERY missing item (never stops
 * at the first) so a reviewer can fix them in one pass.
 */
export function checkCompileReady(model: Model, settings: CompileSettings): ReadinessResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const notCompiled: NotCompiled[] = [];
  const taskWindows: Record<string, number> = {};

  if (!settings.formTitle || settings.formTitle.trim() === "") missing.push("settings.formTitle");
  if (!settings.icon || settings.icon.trim() === "") missing.push("settings.icon");
  if (!settings.contactTypes.person && !settings.contactTypes.place) {
    missing.push("settings.contactTypes (person or place must be true)");
  }
  if (settings.flowMode !== undefined && !FLOW_MODES.includes(settings.flowMode)) {
    missing.push(`settings.flowMode (one of ${FLOW_MODES.join(", ")})`);
  }

  for (const o of model.outcomes) {
    const fu = o.follow_up;
    if (fu === null) continue;
    const base = `outcomes.${o.id}.follow_up`;
    if (fu.kind === "on_return") {
      notCompiled.push({ item: base, reason: ON_RETURN_REASON });
      continue;
    }
    if (fu.due_in_days === null) missing.push(`${base}.due_in_days`);
    const qs = model.open_questions.filter((q) => q.status === "open" && q.affects.includes(o.id)).map((q) => q.id);
    const qText = qs.length > 0 ? qs.join(", ") : "no open question recorded";
    if (fu.task_window_days_after_due !== null) {
      taskWindows[o.id] = fu.task_window_days_after_due;
    } else if (settings.taskWindowDays !== undefined) {
      taskWindows[o.id] = settings.taskWindowDays;
      warnings.push(
        `TEAM_DEFAULT_USED: ${base}.task_window_days_after_due is null; used settings.taskWindowDays = ` +
          `${settings.taskWindowDays} (open question ${qText})`,
      );
    } else {
      missing.push(`${base}.task_window_days_after_due (null and no settings.taskWindowDays; see ${qText})`);
    }
  }

  const questions = new Map(model.questions.map((q) => [q.id, q]));
  const derived = new Set(model.derived.map((d) => d.id));

  const usesDose = model.outcomes.some((o) => o.actions.some((a) => a.dose_by_age !== undefined));
  if (usesDose && questions.get(AGE_FIELD)?.answer_type !== "integer") {
    missing.push(`questions.${AGE_FIELD} (integer; needed by dose_by_age)`);
  }

  const checkCondition = (where: string, root: Condition): void => {
    const stack: Condition[] = [root];
    const found: string[] = [];
    while (stack.length > 0) {
      const c = stack.pop() as Condition;
      if ("all" in c) stack.push(...[...c.all].reverse());
      else if ("any" in c) stack.push(...[...c.any].reverse());
      else {
        const q = questions.get(c.field);
        if (q === undefined && !derived.has(c.field)) {
          found.push(`${where}: "${c.field}" is not a declared question or derived value`);
        } else if (c.op === "is_yes") {
          if (q !== undefined && q.answer_type !== "yes_no") {
            found.push(`${where}: "${c.field}" is not a yes_no question or derived value (is_yes)`);
          }
        } else if (q === undefined || q.answer_type !== "integer") {
          found.push(`${where}: "${c.field}" is not an integer question (${c.op})`);
        }
      }
    }
    for (const f of found) if (!missing.includes(f)) missing.push(f);
  };
  for (const q of model.questions) if (q.shown_when) checkCondition(`questions.${q.id}.shown_when`, q.shown_when);
  for (const d of model.derived) checkCondition(`derived.${d.id}.definition`, d.definition);
  const outcomeIds = new Set(model.outcomes.map((o) => o.id));
  for (const r of [...model.rules].sort((a, b) => a.priority - b.priority)) {
    if (r.when !== "otherwise") checkCondition(`rules.${r.id}.when`, r.when);
    if (!outcomeIds.has(r.outcome)) missing.push(`rules.${r.id}.outcome: "${r.outcome}" is not a declared outcome`);
  }

  return { compile_ready: missing.length === 0, missing, warnings, notCompiled, taskWindows };
}
