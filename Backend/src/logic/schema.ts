import { z } from "zod";

/**
 * Logic model schema for v1.json (schema_version "1.0", DEC-017).
 *
 * Structure only. Cross-references (declared fields, outcome ids, ids unique across
 * namespaces) and semantic checks belong to the validators, not to this parse.
 *
 * Severity convention: LOWER NUMBER = MORE URGENT (1 is the most urgent, 9 the least).
 */

const SHORT = 200;
const TEXT = 2000;
const QUOTE = 2000;
const MAX_LIST = 500;
const MAX_ACTIONS = 50;
const MAX_SOURCES = 20;
export const MAX_CONDITION_DEPTH = 32;

const ID = /^[a-z][a-z0-9_]*$/;

/**
 * Names that every JavaScript object already has (constructor, prototype, toString and so on, in lower case
 * since ids are lower case). An id with one of these names could be confused with the built-in property
 * when answers are looked up, so it is refused.
 */
export const RESERVED_IDS: readonly string[] = [
  "constructor", "prototype", "__proto__", "tostring", "tolocalestring", "valueof", "hasownproperty", "isprototypeof",
  "propertyisenumerable", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__",
];
const notReserved = (s: string): boolean => !RESERVED_IDS.includes(s.toLowerCase());
const reservedMsg = { message: "this name is reserved (every object already has a property with this name)" };
const notBlank = (s: string): boolean => s.trim().length > 0;
const blankMsg = { message: "must not be empty or only spaces" };

const shortStr = z.string().min(1).max(SHORT).refine(notBlank, blankMsg);
const textStr = z.string().min(1).max(TEXT).refine(notBlank, blankMsg);
const idStr = z.string().max(64).regex(ID).refine(notReserved, reservedMsg);

// ---------- Source ----------
const SourceSchema = z
  .object({
    page: z.number().int().min(1).max(100000),
    quote: z
      .string()
      .max(QUOTE)
      .refine((q) => q.trim().length > 0, { message: "quote must not be empty" }),
  })
  .strict();
export type Source = z.output<typeof SourceSchema>;

/** One Source or an array of Sources in the input; always an array in the parsed value. */
const SourceField = z
  .union([SourceSchema, z.array(SourceSchema).min(1).max(MAX_SOURCES)])
  .transform((s): Source[] => (Array.isArray(s) ? s : [s]));

const Origin = z.enum(["guideline", "team", "clinician"]);
export type Origin = z.output<typeof Origin>;

/** origin "guideline" needs at least one source; origin "team" and "clinician" may omit it. */
function needsSource<T extends { origin: Origin; source?: Source[] | undefined }>(
  v: T,
  ctx: z.RefinementCtx,
): void {
  if (v.origin === "guideline" && (v.source === undefined || v.source.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["source"], message: 'origin "guideline" requires at least one source' });
  }
}

// ---------- Condition ----------
export type Condition =
  | { field: string; op: "is_yes" }
  | { field: string; op: "at_least" | "less_than"; value: number }
  | { all: Condition[] }
  | { any: Condition[] };

const Field = z.string().max(64).regex(ID).refine(notReserved, reservedMsg);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: Field, op: z.literal("is_yes") }).strict(),
    z
      .object({ field: Field, op: z.enum(["at_least", "less_than"]), value: z.number().finite() })
      .strict(),
    z.object({ all: z.array(ConditionSchema).min(1).max(MAX_LIST) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(MAX_LIST) }).strict(),
  ]),
);

/**
 * Iterative nesting measure: never recurses, so a 100000-deep or cyclic input cannot
 * overflow the stack. Stops as soon as the limit is passed (a cycle keeps growing and so
 * always trips the limit). Returns the depth reached (leaf = 1).
 */
export function conditionDepth(root: unknown, limit = MAX_CONDITION_DEPTH): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (depth > max) max = depth;
    if (max > limit) return max;
    if (typeof node !== "object" || node === null) continue;
    const o = node as Record<string, unknown>;
    for (const key of ["all", "any"]) {
      const list = o[key];
      if (Array.isArray(list)) for (const child of list) stack.push([child, depth + 1]);
    }
  }
  return max;
}

/** Field names a condition reads, in first-seen order, without duplicates. */
export function collectFieldRefs(condition: Condition): string[] {
  const seen = new Set<string>();
  const stack: Condition[] = [condition];
  while (stack.length > 0) {
    const c = stack.pop() as Condition;
    if ("field" in c) seen.add(c.field);
    else {
      const kids = "all" in c ? c.all : c.any;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Condition);
    }
  }
  return [...seen];
}

// ---------- Question ----------
const ConstraintSchema = z
  .object({ min: z.number().finite(), max: z.number().finite(), message: textStr, origin: Origin })
  .strict()
  .refine((c) => c.min <= c.max, { message: "constraint min must be <= max" });

const QuestionSchema = z
  .object({
    id: idStr,
    order: z.number().int().min(0).max(100000),
    label: textStr,
    answer_type: z.enum(["integer", "yes_no"]),
    unit: shortStr.optional(),
    required: z.boolean(),
    constraint: ConstraintSchema.optional(),
    shown_when: ConditionSchema.optional(),
    origin: Origin,
    source: SourceField.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.constraint !== undefined && q.answer_type !== "integer") {
      ctx.addIssue({ code: "custom", path: ["constraint"], message: "constraint is only allowed on integer questions" });
    }
    needsSource(q, ctx);
  });
export type Question = z.output<typeof QuestionSchema>;

// ---------- Derived ----------
const DerivedSchema = z
  .object({ id: idStr, label: textStr, definition: ConditionSchema, origin: Origin, source: SourceField.optional() })
  .strict()
  .superRefine(needsSource);
export type Derived = z.output<typeof DerivedSchema>;

// ---------- Outcome ----------
const DoseSchema = z
  .object({
    age_months_min: z.number().int().min(0),
    age_months_below: z.number().int().min(0),
    dose: shortStr,
    total: shortStr.optional(),
  })
  .strict();

const ActionSchema = z
  .object({
    text: textStr,
    origin: Origin,
    source: SourceField.optional(),
    dose_by_age: z.array(DoseSchema).min(1).max(MAX_LIST).optional(),
  })
  .strict()
  .superRefine(needsSource);

const FollowUpSchema = z
  .object({
    kind: z.enum(["on_return", "scheduled"]),
    due_in_days: z.number().int().min(0).max(3650).nullable(),
    task_window_days_after_due: z.number().int().min(0).max(3650).nullable(),
    origin: Origin,
    source: SourceField.optional(),
  })
  .strict()
  .superRefine(needsSource);

const OutcomeSchema = z
  .object({
    id: idStr,
    /** 1..9, LOWER NUMBER = MORE URGENT. */
    severity: z.number().int().min(1).max(9),
    title: textStr,
    actions: z.array(ActionSchema).min(1).max(MAX_ACTIONS),
    follow_up: FollowUpSchema.nullable(),
    origin: Origin,
    source: SourceField.optional(),
  })
  .strict()
  .superRefine(needsSource);
export type Outcome = z.output<typeof OutcomeSchema>;

// ---------- Rule ----------
const RuleSchema = z
  .object({
    id: shortStr,
    priority: z.number().int().min(1).max(100000),
    when: z.union([ConditionSchema, z.literal("otherwise")]),
    outcome: idStr,
    origin: Origin,
    source: SourceField.optional(),
  })
  .strict()
  .superRefine(needsSource);
export type Rule = z.output<typeof RuleSchema>;

// ---------- Open question ----------
const OpenQuestionSchema = z
  .object({
    id: shortStr,
    question: textStr,
    affects: z.array(shortStr).max(MAX_LIST),
    route_to: z.enum(["clinician", "program_officer"]),
    status: z.enum(["open", "resolved"]),
    resolution: textStr.optional(),
    source: SourceField.optional(),
  })
  .strict();
export type OpenQuestion = z.output<typeof OpenQuestionSchema>;

// ---------- Model ----------
const ModelSchema = z
  .object({
    schema_version: z.literal("1.0"),
    meta: z
      .object({
        pathway_id: z.string().max(64).regex(ID),
        version: z.number().int().min(1),
        parent_version: z.number().int().min(1).nullable(),
        created_at: z.iso.datetime({ offset: true }),
        created_by: shortStr,
        change_note: z.string().max(TEXT),
        guideline: z
          .object({
            title: shortStr,
            publisher: shortStr,
            edition: shortStr,
            file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      })
      .strict(),
    scope: z
      .object({
        age_months_min: z.number().int().min(0),
        age_months_below: z.number().int().min(0),
        source: SourceField,
        excluded: z.array(z.object({ item: textStr, reason: textStr }).strict()).max(MAX_LIST),
      })
      .strict(),
    questions: z.array(QuestionSchema).min(1).max(MAX_LIST),
    derived: z.array(DerivedSchema).max(MAX_LIST),
    outcomes: z.array(OutcomeSchema).min(1).max(MAX_LIST),
    hit_policy: z.literal("first_match_by_priority"),
    rules: z.array(RuleSchema).min(1).max(MAX_LIST),
    open_questions: z.array(OpenQuestionSchema).max(MAX_LIST),
  })
  .strict()
  .superRefine((m, ctx) => {
    // question order: unique and ascending in array order
    let prev = -Infinity;
    const orders = new Set<number>();
    m.questions.forEach((q, i) => {
      if (orders.has(q.order)) {
        ctx.addIssue({ code: "custom", path: ["questions", i, "order"], message: `duplicate order ${q.order}` });
      } else if (q.order <= prev) {
        ctx.addIssue({ code: "custom", path: ["questions", i, "order"], message: "order must ascend in array order" });
      }
      orders.add(q.order);
      prev = Math.max(prev, q.order);
    });
    // rule priority unique; exactly one "otherwise", on the highest priority
    const prios = new Set<number>();
    m.rules.forEach((r, i) => {
      if (prios.has(r.priority)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "priority"], message: `duplicate priority ${r.priority}` });
      }
      prios.add(r.priority);
    });
    const top = Math.max(...m.rules.map((r) => r.priority));
    const others = m.rules.map((r, i) => [r, i] as const).filter(([r]) => r.when === "otherwise");
    if (others.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: `exactly one "otherwise" rule is required, found ${others.length}`,
      });
    } else if (others[0]![0].priority !== top) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", others[0]![1], "priority"],
        message: 'the "otherwise" rule must have the highest priority',
      });
    }
  });

export type Model = z.output<typeof ModelSchema>;
export type ModelInput = z.input<typeof ModelSchema>;

export type ParseResult = { ok: true; value: Model } | { ok: false; issues: string[] };

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out === "" ? String(p) : `.${String(p)}`;
  return out === "" ? "$" : out;
}

/** Condition locations in a raw model, for the iterative depth pre-check. */
function* rawConditions(input: Record<string, unknown>): Generator<[string, unknown]> {
  const lists: Array<[string, string]> = [
    ["questions", "shown_when"],
    ["derived", "definition"],
    ["rules", "when"],
  ];
  for (const [list, key] of lists) {
    const arr = input[list];
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item === "object" && item !== null && key in item) {
        yield [`${list}[${i}].${key}`, (item as Record<string, unknown>)[key]];
      }
    }
  }
}

export function parseModel(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["$: model must be an object"] };
  }
  const deep: string[] = [];
  for (const [path, cond] of rawConditions(input as Record<string, unknown>)) {
    if (conditionDepth(cond) > MAX_CONDITION_DEPTH) {
      deep.push(`${path}: condition nesting deeper than ${MAX_CONDITION_DEPTH}`);
    }
  }
  if (deep.length > 0) return { ok: false, issues: deep };

  const r = ModelSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`) };
}
