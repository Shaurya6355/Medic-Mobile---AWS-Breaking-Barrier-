/* Front end of the compiler: structural check (is this a spec at all?) then semantic analysis
   (do names resolve, do types fit the operators, is the rule table well formed?).
   "error" means the spec cannot be compiled or run; the backend rejects it. "warning" is for review. */
import { leaves, refs } from "./cond.ts";
import { derivedOrder } from "./evaluate.ts";
import { BOOL_OPS, NUM_OPS, SCHEMA_OPS, item, srcList, type Cond, type ItemId, type Origin, type Sources, type Spec } from "./types.ts";

export interface Diagnostic { level: "error" | "warning"; item: ItemId; path: string; message: string }

/* ---------- Structure ---------- */
type J = unknown;
const isObj = (x: J): x is Record<string, J> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: J) => Number.isInteger(x);

export function checkStructure(x: J): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (path: string, message: string, it: ItemId = "scope") => out.push({ level: "error", item: it, path, message });
  const need = (o: Record<string, J>, k: string, p: string, ok: (v: J) => boolean, what: string, it?: ItemId, optional = false) => {
    if (!(k in o) || o[k] === undefined) { if (!optional) err(p + "." + k, "missing " + what, it); return; }
    if (!ok(o[k])) err(p + "." + k, "must be " + what, it);
  };
  const str = (v: J) => typeof v === "string" && v.trim().length > 0;
  const strOrEmpty = (v: J) => typeof v === "string";
  const nullable = (f: (v: J) => boolean) => (v: J) => v === null || f(v);
  const origin = (v: J) => v === "guideline" || v === "team";
  const one = (v: J) => isObj(v) && isInt(v.page) && (v.page as number) >= 1 && str(v.quote);
  const source = (v: J) => one(v) || (Array.isArray(v) && v.length > 0 && v.every(one));
  const arr = (v: J) => Array.isArray(v);
  const cond = (v: J, p: string, it: ItemId): void => {
    if (!isObj(v)) { err(p, "must be a condition object", it); return; }
    if ("field" in v) {
      if (!str(v.field)) err(p + ".field", "must be a field id", it);
      if (![...BOOL_OPS, ...NUM_OPS].includes(v.op as never)) err(p + ".op", "unknown operator " + JSON.stringify(v.op), it);
      else if (NUM_OPS.includes(v.op as never) && typeof v.value !== "number") err(p + ".value", "a number is needed for " + v.op, it);
      else if (BOOL_OPS.includes(v.op as never) && "value" in v) err(p + ".value", v.op + " takes no value", it);
    } else if ("all" in v || "any" in v) {
      const k = "all" in v ? "all" : "any";
      if (!Array.isArray(v[k])) err(p + "." + k, "must be a list of conditions", it);
      else (v[k] as J[]).forEach((y, i) => cond(y, p + "." + k + "[" + i + "]", it));
    } else if ("not" in v) cond(v.not, p + ".not", it);
    else err(p, "a condition needs field/op, all, any or not", it);
  };

  if (!isObj(x)) { err("", "the logic model must be a JSON object"); return out; }
  if (x.schema_version !== "1.0") err("schema_version", "must be \"1.0\"");
  if (x.hit_policy !== "first_match_by_priority") err("hit_policy", "must be \"first_match_by_priority\"");
  if (!isObj(x.meta)) err("meta", "missing meta");
  else {
    need(x.meta, "pathway_id", "meta", str, "a string");
    need(x.meta, "version", "meta", isInt, "an integer");
    need(x.meta, "parent_version", "meta", nullable(isInt), "an integer or null");
    ["created_at", "created_by", "change_note"].forEach(k => need(x.meta as Record<string, J>, k, "meta", strOrEmpty, "a string"));
    if (!isObj(x.meta.guideline)) err("meta.guideline", "missing guideline");
    else ["title", "publisher", "edition", "file_sha256"].forEach(k => need((x.meta as Record<string, Record<string, J>>).guideline, k, "meta.guideline", strOrEmpty, "a string"));
  }
  if (!isObj(x.scope)) err("scope", "missing scope");
  else {
    need(x.scope, "age_months_min", "scope", isInt, "an integer");
    need(x.scope, "age_months_below", "scope", isInt, "an integer");
    need(x.scope, "source", "scope", source, "{page, quote} or a list of them", "scope", true);
    need(x.scope, "excluded", "scope", v => arr(v) && (v as J[]).every(e => isObj(e) && str(e.item) && strOrEmpty(e.reason)), "a list of {item, reason}");
  }
  const list = (k: string) => { if (!Array.isArray(x[k])) { err(k, "must be a list"); return [] as J[]; } return x[k] as J[]; };

  list("questions").forEach((q, i) => {
    const p = "questions[" + i + "]";
    if (!isObj(q)) return err(p, "must be an object");
    const it = item.q(String(q.id));
    need(q, "id", p, str, "a string", it);
    need(q, "order", p, isInt, "an integer", it);
    need(q, "label", p, strOrEmpty, "a string", it);
    need(q, "answer_type", p, v => v === "yes_no" || v === "integer", "yes_no or integer", it);
    need(q, "unit", p, str, "a string", it, true);
    need(q, "required", p, v => typeof v === "boolean", "true or false", it);
    need(q, "origin", p, origin, "guideline or team", it);
    need(q, "source", p, source, "{page, quote} or a list of them", it, true);
    if ("constraint" in q) {
      if (!isObj(q.constraint)) err(p + ".constraint", "must be an object", it);
      else {
        need(q.constraint, "min", p + ".constraint", v => typeof v === "number", "a number", it, true);
        need(q.constraint, "max", p + ".constraint", v => typeof v === "number", "a number", it, true);
        need(q.constraint, "message", p + ".constraint", strOrEmpty, "a string", it, true);
      }
    }
    if ("shown_when" in q) cond(q.shown_when, p + ".shown_when", it);
  });
  list("derived").forEach((d, i) => {
    const p = "derived[" + i + "]";
    if (!isObj(d)) return err(p, "must be an object");
    const it = item.d(String(d.id));
    need(d, "id", p, str, "a string", it);
    need(d, "label", p, strOrEmpty, "a string", it);
    need(d, "origin", p, origin, "guideline or team", it);
    need(d, "source", p, source, "{page, quote} or a list of them", it, true);
    if (!("definition" in d)) err(p + ".definition", "missing definition", it); else cond(d.definition, p + ".definition", it);
  });
  list("outcomes").forEach((o, i) => {
    const p = "outcomes[" + i + "]";
    if (!isObj(o)) return err(p, "must be an object");
    const it = item.out(String(o.id));
    need(o, "id", p, str, "a string", it);
    need(o, "severity", p, isInt, "an integer", it);
    need(o, "title", p, strOrEmpty, "a string", it);
    need(o, "origin", p, origin, "guideline or team", it);
    need(o, "source", p, source, "{page, quote} or a list of them", it, true);
    if (!Array.isArray(o.actions)) err(p + ".actions", "must be a list", it);
    else (o.actions as J[]).forEach((a, k) => {
      const pa = p + ".actions[" + k + "]";
      if (!isObj(a)) return err(pa, "must be an object", it);
      need(a, "text", pa, strOrEmpty, "a string", it);
      need(a, "origin", pa, origin, "guideline or team", it);
      need(a, "source", pa, source, "{page, quote} or a list of them", it, true);
      need(a, "dose_by_age", pa, v => arr(v) && (v as J[]).every(r => isObj(r) && isInt(r.age_months_min) && isInt(r.age_months_below) && str(r.dose)), "a list of {age_months_min, age_months_below, dose}", it, true);
    });
    if (!("follow_up" in o)) err(p + ".follow_up", "missing follow_up (use null for none)", it);
    else if (o.follow_up !== null) {
      const f = o.follow_up, pf = p + ".follow_up", fi = item.fu(String(o.id));
      if (!isObj(f)) err(pf, "must be an object or null", fi);
      else {
        need(f, "kind", pf, v => v === "scheduled" || v === "on_return", "scheduled or on_return", fi);
        need(f, "due_in_days", pf, nullable(isInt), "an integer or null", fi);
        need(f, "task_window_days_after_due", pf, nullable(isInt), "an integer or null", fi);
        need(f, "origin", pf, origin, "guideline or team", fi);
        need(f, "source", pf, source, "{page, quote} or a list of them", fi, true);
      }
    }
  });
  list("rules").forEach((r, i) => {
    const p = "rules[" + i + "]";
    if (!isObj(r)) return err(p, "must be an object");
    const it = item.rule(String(r.id));
    need(r, "id", p, str, "a string", it);
    need(r, "priority", p, isInt, "an integer", it);
    need(r, "outcome", p, str, "an outcome id", it);
    need(r, "origin", p, origin, "guideline or team", it);
    need(r, "source", p, source, "{page, quote} or a list of them", it, true);
    if (r.when !== "otherwise") cond(r.when, p + ".when", it);
  });
  list("open_questions").forEach((q, i) => {
    const p = "open_questions[" + i + "]";
    if (!isObj(q)) return err(p, "must be an object");
    need(q, "id", p, str, "a string");
    need(q, "question", p, str, "a string");
    need(q, "affects", p, v => arr(v) && (v as J[]).every(str), "a list of ids");
    need(q, "route_to", p, v => v === "clinician" || v === "program_officer", "clinician or program_officer");
    need(q, "status", p, v => v === "open" || v === "resolved", "open or resolved");
    need(q, "resolution", p, str, "a string", "scope", true);
    need(q, "source", p, source, "{page, quote} or a list of them", "scope", true);
  });
  return out;
}

/* ---------- Semantics ---------- */
/** Questions and derived values the rules depend on, directly or through derived values. */
export function usedFields(spec: Spec): Set<string> {
  const defs = new Map(spec.derived.map(d => [d.id, d.definition]));
  const seen = new Set<string>();
  const visit = (f: string) => { if (seen.has(f)) return; seen.add(f); const d = defs.get(f); if (d) refs(d).forEach(visit); };
  spec.rules.forEach(r => { if (r.when !== "otherwise") refs(r.when).forEach(visit); });
  return seen;
}

export function analyze(spec: Spec): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (level: Diagnostic["level"], it: ItemId, path: string, message: string) => out.push({ level, item: it, path, message });
  const ID = /^[a-z][a-z0-9_]*$/;
  const qs = new Map(spec.questions.map(q => [q.id, q]));
  const ds = new Map(spec.derived.map(d => [d.id, d]));
  const outs = new Map(spec.outcomes.map(o => [o.id, o]));

  // Names: one namespace for fields (questions + derived), one each for outcomes and rules.
  const dup = (ids: string[], what: string, it: (id: string) => ItemId) => {
    const s = new Set<string>();
    ids.forEach(id => { if (s.has(id)) add("error", it(id), what, "Duplicate id " + id + "."); s.add(id); });
  };
  dup([...spec.questions.map(q => q.id), ...spec.derived.map(d => d.id)], "questions/derived", id => (qs.has(id) ? item.q(id) : item.d(id)));
  dup(spec.outcomes.map(o => o.id), "outcomes", item.out);
  dup(spec.rules.map(r => r.id), "rules", item.rule);
  [...spec.questions.map(q => [q.id, item.q(q.id)]), ...spec.derived.map(d => [d.id, item.d(d.id)]), ...spec.outcomes.map(o => [o.id, item.out(o.id)])]
    .forEach(([id, it]) => { if (!ID.test(id)) add("error", it, "id", "Id " + JSON.stringify(id) + " must be lower_snake_case (it becomes an XLSForm field name)."); });

  // Type check every condition. Schema 1.0 allows only is_yes, at_least, less_than, all and any.
  const checkCond = (c: Cond, it: ItemId, path: string, allowDerived = true) => {
    const hasNot = (x: Cond): boolean => "not" in x || ("all" in x && x.all.some(hasNot)) || ("any" in x && x.any.some(hasNot));
    if (hasNot(c)) add("error", it, path, "\"not\" is not allowed in schema 1.0. Rewrite it with is yes, >= or <.");
    leaves(c).forEach(({ leaf: l }) => {
      if (!SCHEMA_OPS.includes(l.op)) add("error", it, path, l.field + ": schema 1.0 allows only \"is yes\", \">=\" and \"<\".");
      const q = qs.get(l.field), d = ds.get(l.field);
      if (!q && !d) return add("error", it, path, "Unknown field " + l.field + ".");
      if (d && !allowDerived) return add("error", it, path, "A show condition may only use questions, not the derived value " + l.field + ".");
      const isBool = !!d || q!.answer_type === "yes_no";
      if (BOOL_OPS.includes(l.op) && !isBool) add("error", it, path, l.field + " is a number; use >=, <, ... not \"is yes/no\".");
      if (NUM_OPS.includes(l.op) && isBool) add("error", it, path, l.field + " is yes/no; compare it with \"is yes\" or \"is no\".");
    });
  };

  // Anything taken from the guideline must cite where.
  const cites = (origin: Origin, src: Sources | undefined, it: ItemId, path: string) => {
    if (origin === "guideline" && !srcList(src).length) add("error", it, path, "Marked as from the guideline but cites no passage.");
  };
  spec.questions.forEach(q => cites(q.origin, q.source, item.q(q.id), "source"));
  spec.derived.forEach(d => cites(d.origin, d.source, item.d(d.id), "source"));
  spec.rules.forEach(r => cites(r.origin, r.source, item.rule(r.id), "source"));
  spec.outcomes.forEach(o => {
    cites(o.origin, o.source, item.out(o.id), "source");
    o.actions.forEach((a, i) => cites(a.origin, a.source, item.out(o.id), "actions[" + i + "].source"));
    if (o.follow_up) cites(o.follow_up.origin, o.follow_up.source, item.fu(o.id), "follow_up.source");
    if (o.severity < 1 || o.severity > 9) add("error", item.out(o.id), "severity", "Severity must be 1 (most urgent) to 9.");
  });

  // Scope.
  if (spec.scope.age_months_min >= spec.scope.age_months_below) add("error", item.scope, "scope", "The age range is empty.");

  // Questions.
  const orders = new Set<number>();
  spec.questions.forEach(q => {
    const it = item.q(q.id);
    if (orders.has(q.order)) add("warning", it, "order", "Two questions share order " + q.order + ".");
    orders.add(q.order);
    if (!q.label.trim()) add("error", it, "label", "Question has no label.");
    const c = q.constraint;
    if (c && c.min !== undefined && c.max !== undefined && c.min > c.max) add("error", it, "constraint", "Entry limit min is above max.");
    if (c && q.answer_type === "yes_no") add("warning", it, "constraint", "Entry limits only apply to numbers.");
    if (q.shown_when) {
      checkCond(q.shown_when, it, "shown_when", false);
      refs(q.shown_when).forEach(f => {
        const r = qs.get(f);
        if (r && r.order >= q.order) add("error", it, "shown_when", "Shown when uses " + f + ", which is asked later (or is this question).");
      });
    }
  });

  // Derived values.
  spec.derived.forEach(d => { if (!d.label.trim()) add("error", item.d(d.id), "label", "Derived value has no label."); checkCond(d.definition, item.d(d.id), "definition"); });
  try { derivedOrder(spec); } catch (e) { add("error", item.d(spec.derived[0]?.id ?? ""), "definition", (e as Error).message); }

  // Rule table.
  const prios = new Map<number, string>();
  spec.rules.forEach(r => {
    const it = item.rule(r.id);
    if (prios.has(r.priority)) add("error", it, "priority", "Priority " + r.priority + " is also used by " + prios.get(r.priority) + "; first match would be ambiguous.");
    prios.set(r.priority, r.id);
    if (!outs.has(r.outcome)) add("error", it, "outcome", "Unknown outcome " + r.outcome + ".");
    if (r.when !== "otherwise") checkCond(r.when, it, "when");
  });
  const sorted = spec.rules.slice().sort((a, b) => a.priority - b.priority);
  const other = sorted.filter(r => r.when === "otherwise");
  if (!other.length) add("error", sorted.length ? item.rule(sorted[sorted.length - 1].id) : item.scope, "rules", "No \"otherwise\" rule: some patients would get no outcome.");
  if (other.length > 1) other.slice(1).forEach(r => add("error", item.rule(r.id), "when", "Only one \"otherwise\" rule is allowed."));
  if (other.length && sorted[sorted.length - 1] !== other[0]) add("error", item.rule(other[0].id), "priority", "The \"otherwise\" rule must have the last priority; rules after it can never fire.");

  // Outcomes.
  const target = new Set(spec.rules.map(r => r.outcome));
  spec.outcomes.forEach(o => {
    const it = item.out(o.id);
    if (!o.title.trim()) add("error", it, "title", "Outcome has no title.");
    if (!target.has(o.id)) add("warning", it, "id", "No rule leads to this outcome.");
    o.actions.forEach((a, k) => (a.dose_by_age || []).forEach(r => {
      if (r.age_months_min >= r.age_months_below) add("error", it, "actions[" + k + "].dose_by_age", "Dose row " + r.age_months_min + "-" + r.age_months_below + " months is empty.");
      if (r.age_months_min < spec.scope.age_months_min || r.age_months_below > spec.scope.age_months_below) add("warning", it, "actions[" + k + "].dose_by_age", "Dose row " + r.age_months_min + "-" + r.age_months_below + " months is outside the form's age range.");
    }));
    const f = o.follow_up;
    if (f) {
      if (f.kind === "scheduled" && f.due_in_days === null) add("error", item.fu(o.id), "follow_up.due_in_days", "A scheduled follow-up needs a due day.");
      if (f.due_in_days !== null && f.due_in_days < 0) add("error", item.fu(o.id), "follow_up.due_in_days", "Due day cannot be negative.");
      if (f.task_window_days_after_due !== null && f.task_window_days_after_due < 0) add("error", item.fu(o.id), "follow_up.task_window_days_after_due", "Task window cannot be negative.");
    }
  });

  // Unused questions.
  const used = usedFields(spec);
  spec.questions.forEach(q => {
    const gates = spec.questions.some(o => o.shown_when && refs(o.shown_when).includes(q.id) && used.has(o.id));
    if (!used.has(q.id) && !gates) add("warning", item.q(q.id), "id", "Asked on the form but no rule uses it.");
  });
  spec.derived.forEach(d => { if (!used.has(d.id)) add("warning", item.d(d.id), "id", "No rule uses this derived value."); });

  // Open questions point at real things.
  spec.open_questions.forEach(q => q.affects.forEach(a => { if (!itemOf(spec, a)) add("warning", item.scope, "open_questions." + q.id, q.id + " refers to unknown id " + a + "."); }));
  return out;
}

/** Map a bare id (as used in open_questions.affects) to the item that owns it. */
export function itemOf(spec: Spec, id: string): ItemId | null {
  if (spec.questions.some(q => q.id === id)) return item.q(id);
  if (spec.derived.some(d => d.id === id)) return item.d(id);
  if (spec.outcomes.some(o => o.id === id)) return item.out(id);
  if (spec.rules.some(r => r.id === id)) return item.rule(id);
  return null;
}

/** Structure, then semantics. A spec is usable only when there are no errors. */
export function validateSpec(x: unknown): { spec: Spec | null; diagnostics: Diagnostic[] } {
  const s = checkStructure(x);
  if (s.length) return { spec: null, diagnostics: s };
  const spec = x as Spec;
  const d = analyze(spec);
  return { spec: d.some(e => e.level === "error") ? null : spec, diagnostics: d };
}
