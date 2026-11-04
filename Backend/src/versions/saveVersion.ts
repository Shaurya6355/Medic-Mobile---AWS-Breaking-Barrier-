import { createHash, randomUUID } from "node:crypto";
import { NotFound, artifactKey, type ArtifactStore } from "../artifacts/artifactStore.js";
import type { VersionOrigin } from "../domain/types.js";
import type { Store } from "../store/store.js";
import type { LogicModelValidator } from "../steps/logicModelValidator.js";

export interface SaveVersionDeps {
  store: Store;
  artifacts: ArtifactStore;
  validator: LogicModelValidator;
  onVersionSaved: (runId: string, n: number) => Promise<void>;
  now: () => number;
}

export interface SaveVersionInput {
  runId: string;
  parentVersion: number;
  body: unknown;
  author: string;
  authorRole?: "program_officer" | "clinician";
  origin: VersionOrigin;
  change?: {
    ops?: unknown;
    behaviourChanges?: unknown;
    targetedFindings?: string[];
    modelId?: string;
    promptSha?: string;
    costUsd?: number;
  };
  idempotencyKey?: string;
}

export type SaveVersionResult =
  | { ok: true; n: number; checks_status: "ok" | "failed"; message?: string }
  | { ok: false; status: 404 | 409 | 422; error: string; issues?: string[]; expected?: unknown };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Paths (JSON pointers) where two JSON values differ, capped. Structure only, no values. */
export function structuralDiff(before: unknown, after: unknown, cap = 200): { path: string; change: "added" | "removed" | "changed" }[] {
  const out: { path: string; change: "added" | "removed" | "changed" }[] = [];
  const isO = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= cap) return;
    if (isO(a) && isO(b) && Array.isArray(a) === Array.isArray(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const p = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (!(k in a)) out.push({ path: p, change: "added" });
        else if (!(k in b)) out.push({ path: p, change: "removed" });
        else walk(a[k], b[k], p);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || "/", change: "changed" });
  };
  walk(before, after, "");
  return out;
}

const idemKey = (runId: string, key: string): string => artifactKey(runId, "idempotency", `${sha256(key)}.json`);

function noteFor(i: SaveVersionInput, diffCount: number): string {
  const who = i.origin === "officer_agent" ? "The officer agent" : i.origin === "tree_edit" ? `${i.author} (tree edit)` : i.origin === "restore" ? `${i.author} (restore)` : i.author;
  return `${who} saved version from version ${i.parentVersion}; ${diffCount} place${diffCount === 1 ? "" : "s"} changed.`;
}

export async function saveVersion(deps: SaveVersionDeps, input: SaveVersionInput): Promise<SaveVersionResult> {
  const { store, artifacts, validator, onVersionSaved, now } = deps;
  const { runId } = input;
  if (!(await store.getRun(runId))) return { ok: false, status: 404, error: "not_found" };

  if (input.idempotencyKey !== undefined) {
    try {
      const prior = JSON.parse(new TextDecoder().decode(await artifacts.get(idemKey(runId, input.idempotencyKey)))) as SaveVersionResult;
      return prior;
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
  }

  const versions = await store.listVersions(runId);
  const latest = versions[versions.length - 1];
  if (!latest) return { ok: false, status: 409, error: "no_base_version" };
  if (input.parentVersion !== latest.n) return { ok: false, status: 409, error: "conflict" };
  const result = validator.validate(input.body);
  if (!result.ok) return { ok: false, status: 422, error: "invalid_logic_model", issues: result.issues };

  const n = latest.n + 1;
  // The body must say where it sits in the chain (DEC-020).
  const meta = (input.body as { meta?: { version?: unknown; parent_version?: unknown } }).meta ?? {};
  if (meta.version !== n || meta.parent_version !== latest.n) {
    return {
      ok: false,
      status: 422,
      error: "version_mismatch",
      issues: [`meta.version must be ${n} and meta.parent_version must be ${latest.n} (got ${String(meta.version)} and ${String(meta.parent_version)})`],
      expected: { version: n, parent_version: latest.n },
    };
  }

  const key = artifactKey(runId, "versions", `v${n}-${randomUUID()}.json`);
  const text = JSON.stringify(input.body, null, 2);
  await artifacts.put(key, text, "application/json");

  // Change record, written before the version exists (Phase 2c); its sha goes on the version item.
  let parentBody: unknown = undefined;
  try {
    parentBody = JSON.parse(new TextDecoder().decode(await artifacts.get(latest.artifactKey)));
  } catch {
    parentBody = undefined;
  }
  const diff = parentBody === undefined ? [] : structuralDiff(parentBody, input.body);
  const changeNote = noteFor(input, diff.length);
  const changeText = JSON.stringify(
    {
      runId,
      n,
      base: { version: latest.n, bodySha256: latest.bodySha256 ?? null },
      origin: input.origin,
      ops: input.change?.ops ?? null,
      structuralDiff: diff,
      behaviourChanges: input.change?.behaviourChanges ?? null,
      actor: { author: input.author, role: input.authorRole ?? null },
      agent:
        input.origin === "officer_agent"
          ? {
              targetedFindings: input.change?.targetedFindings ?? [],
              modelId: input.change?.modelId ?? null,
              promptSha: input.change?.promptSha ?? null,
              costUsd: input.change?.costUsd ?? null,
            }
          : null,
      bodySha256: sha256(text),
      at: now(),
    },
    null,
    2,
  );
  const changeKey = artifactKey(runId, "changes", `v${n}.json`);
  await artifacts.put(changeKey, changeText, "application/json");

  await store.addVersion({
    runId,
    n,
    parent: latest.n,
    author: input.author,
    ...(input.authorRole !== undefined ? { authorRole: input.authorRole } : {}),
    createdAt: now(),
    artifactKey: key,
    bodySha256: sha256(text),
    origin: input.origin,
    changeNote,
    changeKey,
    changeSha256: sha256(changeText),
  });

  let out: SaveVersionResult;
  try {
    await onVersionSaved(runId, n);
    out = { ok: true, n, checks_status: "ok" };
  } catch {
    // Saved, but the checks did not finish: never report plain success.
    out = {
      ok: true,
      n,
      checks_status: "failed",
      message: "The version was saved but its checks did not finish. They run again when the version is opened; if the run shows failed, resume it.",
    };
  }
  if (input.idempotencyKey !== undefined) await artifacts.put(idemKey(runId, input.idempotencyKey), JSON.stringify(out), "application/json");
  return out;
}
