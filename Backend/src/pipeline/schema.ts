import { z } from "zod";

/* Zod mirror of the logic model in Frontend/src/domain/types.ts (Model). Keep the two in step.
   Every logic model, placeholder or agent, must pass this before it is stored or served. */

const cond = z.enum(["ci", "stridor", "fast"]);
const sign = z.enum(["drink", "vomit", "conv", "leth"]);
const text = z.string().min(1);
const outcome = z.object({ title: text, note: text }).strict();
const quote = z.tuple([text, text]);

export const QuestionSchema = z.object({
  type: z.enum(["yesno", "int", "multi"]),
  label: text,
  showIf: z.string(),
  quote: text,
}).strict();

export const ModelSchema = z.object({
  start: z.object({ ageMin: z.number().int().min(0), ageMax: z.number().int().positive() }).strict(),
  d1: z.object({ q: text, signs: z.array(sign) }).strict(),
  d2: z.object({ q: text, conds: z.array(cond), hint: z.string() }).strict(),
  d3: z.object({ q: text, conds: z.array(cond), cut: z.number().int().positive(), young: z.number().int().positive(), old: z.number().int().positive(), hint: z.string() }).strict(),
  o1: outcome, o2: outcome, o3: outcome,
  f1: z.object({ title: text, due: z.number().int().positive(), end: z.number().int().positive() }).strict(),
  src: z.object({ start: quote, d1: quote, d2: quote, d3: quote, o1: quote, o2: quote, o3: quote, f1: quote }).strict(),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), QuestionSchema).refine(q => Object.keys(q).length > 0, "at least one question"),
}).strict()
  .refine(m => m.start.ageMin < m.start.ageMax, { message: "start.ageMin must be below start.ageMax", path: ["start"] })
  .refine(m => m.f1.due <= m.f1.end, { message: "f1.due must not be after f1.end", path: ["f1"] });

export type LogicModel = z.infer<typeof ModelSchema>;
