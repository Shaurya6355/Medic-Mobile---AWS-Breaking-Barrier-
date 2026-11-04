import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseModel, type Model } from "../../src/logic/index.js";
import type { CompileSettings } from "../../src/compiler/types.js";

const dir = dirname(fileURLToPath(import.meta.url));

export function rawV1(): any {
  return JSON.parse(readFileSync(join(dir, "..", "fixtures", "logic", "v1.json"), "utf8"));
}

export function parse(raw: unknown): Model {
  const r = parseModel(raw);
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.value;
}

export function v1(): Model {
  return parse(rawV1());
}

export function demoSettings(over: Partial<CompileSettings> = {}): CompileSettings {
  return {
    formTitle: "Cough and fast breathing (demo)",
    icon: "icon-healthcare",
    taskWindowDays: 7,
    contactTypes: { person: true, place: false },
    ...over,
  };
}
