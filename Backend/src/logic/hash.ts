import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import type { Model } from "./schema.js";

/**
 * SHA-256 (hex) of the canonical JSON of the model with meta.created_at, meta.created_by and
 * meta.change_note removed. Those three are descriptive: who and when wrote the draft and why.
 * Rewording a change note or re-saving must not change the identity of the clinical content.
 * meta.version and meta.parent_version stay in the hash because they are part of the lineage
 * (two models that differ only in version are different snapshots).
 */
export function modelSha(model: Model): string {
  const { created_at: _a, created_by: _b, change_note: _c, ...meta } = model.meta;
  const hashed = { ...model, meta };
  return createHash("sha256").update(canonicalJson(hashed), "utf8").digest("hex");
}
