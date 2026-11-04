import { z } from "zod";

export const RunState = z.enum([
  "created",
  "ingesting",
  "extracting",
  "filling_logic",
  "in_review",
  "checking",
  "failed",
]);
export type RunState = z.infer<typeof RunState>;

export const CreateRunRequest = z.object({
  pages: z
    .array(z.number().int().positive())
    .refine((p) => new Set(p).size === p.length, { message: "pages must not contain duplicates" })
    .optional(),
  filename: z.string().min(1),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  runId: z.string(),
  uploadUrl: z.string(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const SaveVersionRequest = z.object({
  parentVersion: z.number().int().nonnegative(),
  body: z.unknown(),
  author: z.string().min(1),
});
export type SaveVersionRequest = z.infer<typeof SaveVersionRequest>;

export const CreateCommentRequest = z.object({
  itemRef: z.string().min(1),
  text: z.string().min(1),
  author: z.string().min(1),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;
