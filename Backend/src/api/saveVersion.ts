import { createHash, randomUUID } from "node:crypto";
import { artifactKey } from "../artifacts/artifactStore.js";
import type { ArtifactStore } from "../artifacts/artifactStore.js";
import type { SignerRole } from "../contract/schemas.js";
import type { Store } from "../store/store.js";

export interface SaveVersionIo {
  store: Store;
  artifacts: ArtifactStore;
  now: () => number;
}

export interface NewVersion {
  runId: string;
  /** The number the new version takes: latest + 1. The store rejects a taken number with Conflict. */
  n: number;
  parent: number;
  author: string;
  authorRole?: SignerRole;
  body: unknown;
}

/**
 * The one place a new logic model version is written, shared by POST /versions (a hand edit) and the
 * revision service (an AI revision), so both leave the same record: the artifact first, so a version never
 * points at a missing object, then the version row with the sha256 of the exact stored bytes (DEC-020) and
 * no signatures (AR-02). Callers validate the body and run the checks afterwards (onVersionSaved).
 */
export async function saveNewVersion(io: SaveVersionIo, v: NewVersion): Promise<void> {
  const key = artifactKey(v.runId, "versions", `v${v.n}-${randomUUID()}.json`);
  const text = JSON.stringify(v.body, null, 2);
  await io.artifacts.put(key, text, "application/json");
  await io.store.addVersion({
    runId: v.runId,
    n: v.n,
    parent: v.parent,
    author: v.author,
    ...(v.authorRole !== undefined ? { authorRole: v.authorRole } : {}),
    createdAt: io.now(),
    artifactKey: key,
    // The exact bytes stored, so a release can refuse a body rewritten later (DEC-020).
    bodySha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}
