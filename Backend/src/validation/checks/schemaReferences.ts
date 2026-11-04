import { parseModel, collectFieldRefs } from "../../logic/schema.js";
import type { Condition, Model } from "../../logic/schema.js";
import { evalCondition } from "../../logic/interpreter.js";
import { OFFICER, makeFinding } from "../finding.js";
import type { CheckContext, Finding, FindingParams, Subject } from "../finding.js";
import {
  derivedSubject,
  describeDerived,
  describeOpenQuestion,
  describeQuestion,
  describeRule,
  openQuestionSubject,
  questionSubject,
  ruleSubject,
} from "../describe.js";
import { clip } from "../text.js";

const CHECK = "schemaReferences";

/** The model parses with the schema, then every reference inside it resolves and each test suits its field. */
export function schemaReferences(ctx: CheckContext): Finding[] {
  const parsed = parseModel(ctx.model);
  if (!parsed.ok) {
    return parsed.issues.map((issue) => {
      const i = issue.indexOf(": ");
      return makeFinding({
        check: CHECK,
        code: "SCHEMA_INVALID",
        severity: "blocking",
        audience: OFFICER,
        decidedBy: "program_officer",
        subjects: [{ kind: "document", id: "model" }],
        params: { path: i < 0 ? "$" : issue.slice(0, i) || "$", issue: clip(i < 0 ? issue : issue.slice(i + 2), 200) },
        source: [],
      });
    });
  }
  return references(parsed.value);
}

type FieldInfo = { kind: "question" | "derived"; label: string; integer: boolean; index: number };

function references(model: Model): Finding[] {
  const out: Finding[] = [];
  const add = (
    code: string,
    subjects: Subject[],
    params: FindingParams,
    severity: "blocking" | "warning" | "info" = "blocking",
  ): void => {
    out.push(makeFinding({ check: CHECK, code, severity, audience: OFFICER, decidedBy: "program_officer", subjects, params, source: [] }));
  };

  const fields = new Map<string, FieldInfo>();
  model.questions.forEach((q, index) => {
    if (!fields.has(q.id)) fields.set(q.id, { kind: "question", label: q.label, integer: q.answer_type === "integer", index });
  });
  model.derived.forEach((d, index) => {
    if (!fields.has(d.id)) fields.set(d.id, { kind: "derived", label: d.label, integer: false, index });
  });
  const outcomeIds = new Set(model.outcomes.map((o) => o.id));

  // Unique ids across questions, derived values, results, rules and open questions.
  const uses = new Map<string, { label: string; subject: Subject }[]>();
  const note = (id: string, label: string, subject: Subject): void => {
    uses.set(id, [...(uses.get(id) ?? []), { label, subject }]);
  };
  model.questions.forEach((q) => note(q.id, "question", questionSubject(q)));
  model.derived.forEach((d) => note(d.id, "calculated value", derivedSubject(d)));
  model.outcomes.forEach((o) => note(o.id, "result", { kind: "outcome", id: o.id }));
  model.rules.forEach((r) => note(r.id, "rule", ruleSubject(r)));
  model.open_questions.forEach((q) => note(q.id, "open question", openQuestionSubject(q)));
  for (const [id, l] of [...uses].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (l.length < 2) continue;
    const subjects = [...new Map(l.map((x) => [x.subject.kind + x.subject.id, x.subject])).values()];
    add("DUPLICATE_ID", subjects, { id, kinds: l.map((x) => x.label).sort().join(", ") });
  }

  type Mode = { kind: "shown_when"; before: number } | { kind: "definition" } | { kind: "rule" };
  const checkCondition = (root: Condition, subject: Subject, item: string, where: string, mode: Mode): void => {
    const stack: Condition[] = [root];
    while (stack.length > 0) {
      const c = stack.pop() as Condition;
      if (!("field" in c)) {
        const kids = "all" in c ? c.all : c.any;
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Condition);
        continue;
      }
      const f = fields.get(c.field);
      if (f === undefined) {
        add("UNKNOWN_VARIABLE", [subject], { item, variable: c.field, where });
        continue;
      }
      if (mode.kind === "shown_when") {
        if (f.kind === "derived") {
          add("RELEVANCE_READS_DERIVED", [subject], { question: item, derived: f.label });
          continue;
        }
        if (f.index >= mode.before) {
          add("RELEVANCE_READS_LATER_QUESTION", [subject], { question: item, later: f.label });
          continue;
        }
      }
      const fieldSubject: Subject = f.kind === "question" ? { kind: "question", id: c.field } : { kind: "derived", id: c.field };
      if (c.op === "is_yes") {
        if (f.integer) {
          add("OPERATOR_MISUSE", [subject, fieldSubject], { item, variable: f.label, problem: "it is answered with a number, so it cannot be tested for yes" });
        }
      } else if (!f.integer) {
        add("OPERATOR_MISUSE", [subject, fieldSubject], {
          item,
          variable: f.label,
          problem: f.kind === "derived" ? "a calculated value is yes or no, so it cannot be compared with a number" : "it is answered yes or no, so it cannot be compared with a number",
        });
      } else if (!Number.isInteger(c.value)) {
        add("TYPE_MISMATCH", [subject, fieldSubject], { item, variable: f.label, expected: "a whole number", got: `the number ${c.value}` });
      }
    }
  };

  model.questions.forEach((q, i) => {
    if (q.shown_when !== undefined) checkCondition(q.shown_when, questionSubject(q), describeQuestion(q), `when the question "${q.id}" is asked`, { kind: "shown_when", before: i });
  });
  model.derived.forEach((d) => checkCondition(d.definition, derivedSubject(d), describeDerived(d), `the calculated value "${d.id}"`, { kind: "definition" }));
  model.rules.forEach((r) => {
    const subject = ruleSubject(r);
    const item = describeRule(model, r);
    if (r.when !== "otherwise") checkCondition(r.when, subject, item, `rule ${r.id}`, { kind: "rule" });
    if (!outcomeIds.has(r.outcome)) add("UNKNOWN_OUTCOME", [subject], { item: `rule ${r.id}`, outcome: r.outcome });
  });

  // Calculated values may read questions and other calculated values, but not in a circle.
  const deps = new Map<string, string[]>();
  for (const d of model.derived) deps.set(d.id, collectFieldRefs(d.definition).filter((x) => fields.get(x)?.kind === "derived"));
  const state = new Map<string, 1 | 2>();
  const cyclic = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1);
    for (const n of deps.get(id) ?? []) {
      if (state.get(n) === 1) for (const p of path.slice(path.indexOf(n) < 0 ? 0 : path.indexOf(n))) cyclic.add(p);
      else if (state.get(n) === undefined) visit(n, [...path, n]);
    }
    state.set(id, 2);
  };
  for (const d of model.derived) if (state.get(d.id) === undefined) visit(d.id, [d.id]);
  for (const d of model.derived) {
    if (cyclic.has(d.id)) {
      add("DERIVED_CYCLE", [derivedSubject(d)], { item: describeDerived(d) });
    }
  }

  // Open questions point at items that exist.
  const known = new Set<string>([...fields.keys(), ...outcomeIds, ...model.rules.map((r) => r.id)]);
  for (const q of model.open_questions) {
    for (const id of q.affects) {
      if (!known.has(id)) add("UNKNOWN_AFFECTED_ITEM", [openQuestionSubject(q)], { item: describeOpenQuestion(q), target: id });
    }
  }

  scopeCheck(model, add);

  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/**
 * If a rule exists whose condition reads only the child's age, it is the rule that handles children outside the
 * covered age range. It should then be true exactly for ages below the lowest covered age or at/above the upper limit.
 */
function scopeCheck(model: Model, add: (code: string, subjects: Subject[], params: FindingParams, severity?: "blocking" | "warning" | "info") => void): void {
  const ages = model.questions.filter((q) => q.unit === "months" && q.answer_type === "integer");
  const age = ages.length === 1 ? ages[0] : undefined;
  if (age === undefined) return;
  const { age_months_min: lo, age_months_below: hi } = model.scope;
  const candidates = [0, lo - 1, lo, lo + 1, hi - 1, hi, hi + 1].filter((a) => a >= 0);
  for (const r of model.rules) {
    if (r.when === "otherwise") continue;
    const refs = collectFieldRefs(r.when);
    if (refs.length !== 1 || refs[0] !== age.id) continue;
    const known = new Set([age.id]);
    const wrong = candidates.filter((a) => evalCondition(r.when as Condition, { [age.id]: a }, known) !== (a < lo || a >= hi));
    if (wrong.length > 0) {
      const a = Math.min(...wrong);
      const inside = a >= lo && a < hi;
      add(
        "SCOPE_RULE_MISMATCH",
        [ruleSubject(r), { kind: "scope", id: "scope" }],
        {
          item: describeRule(model, r),
          lo,
          hi,
          problem: inside
            ? `a child of ${a} months is inside the covered range but this rule would apply to them`
            : `a child of ${a} months is outside the covered range but this rule would not apply to them`,
        },
        "warning",
      );
    }
  }
}
