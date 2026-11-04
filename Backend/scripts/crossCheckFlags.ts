// Flags from two logic models: runs the cross-check (src/validation/checks/crossCheck.ts) on a first and a second
// logic model and prints the flags as JSON. Deterministic, no model call, no network, no AWS credentials.
// Run from Backend/:  npx tsx scripts/crossCheckFlags.ts --first first.json --second second.json
// Backend/validation/compare_outputs.py calls this and stores the result in flags.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseModel } from "../src/logic/schema.js";
import { crossCheck, loadCrossCheck } from "../src/validation/index.js";
import { buildFlags, type Flag, type FlagsSummary } from "../src/validation/flags.js";

export type { Flag };

export type FlagsResult = { ok: false; issues: string[] } | { ok: true; flags: Flag[]; summary: FlagsSummary };

/** First draft: the logic model being checked. Second draft: the independent one. Same input, same flags, same order. */
export function crossCheckFlags(first: unknown, second: unknown): FlagsResult {
  const parsed = parseModel(first);
  if (!parsed.ok) return { ok: false, issues: parsed.issues.slice(0, 20) };
  return { ok: true, ...buildFlags(crossCheck({ model: parsed.value, crossCheck: loadCrossCheck(second) })) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const first = arg("--first");
  const second = arg("--second");
  if (first === undefined || second === undefined) {
    console.error("usage: tsx scripts/crossCheckFlags.ts --first <logic model.json> --second <logic model.json>");
    process.exit(2);
  }
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(readFileSync(first, "utf8"));
    b = JSON.parse(readFileSync(second, "utf8"));
  } catch (e) {
    console.error(`cannot read the logic models: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(crossCheckFlags(a, b)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
