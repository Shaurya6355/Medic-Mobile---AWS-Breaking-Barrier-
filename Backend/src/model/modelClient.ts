import type { z } from "zod";

export type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; format: "png"; bytes: Uint8Array };

export interface ModelClient {
  generateJson<T>(req: {
    modelId: string;
    system: string;
    content: ModelContent[];
    schema: z.ZodType<T>;
    maxTokens: number;
  }): Promise<{
    value: T;
    usage: { inputTokens: number; outputTokens: number; modelId: string };
    raw: string;
  }>;
}
