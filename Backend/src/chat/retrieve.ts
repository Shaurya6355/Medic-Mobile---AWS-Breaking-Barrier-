import type { ArtifactStore } from "../artifacts/artifactStore.js";
import { ingestBlocksKey } from "../signoff/checks.js";

export interface Passage {
  page: number;
  blockId: string;
  text: string;
}

export interface Hit extends Passage {
  score: number;
}

const tokens = (s: string): string[] => (s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);

/** All blocks of the run's ingest artifact (empty when the run has none). Scoped by runId through the key. */
export async function loadPassages(artifacts: ArtifactStore, runId: string): Promise<Passage[]> {
  let doc: { pages?: Array<{ pdf_page: number; blocks?: Array<{ block_id: string; text: string }> }> };
  try {
    doc = JSON.parse(new TextDecoder().decode(await artifacts.get(ingestBlocksKey(runId))));
  } catch {
    return [];
  }
  const out: Passage[] = [];
  for (const p of doc.pages ?? []) for (const b of p.blocks ?? []) if (b.text.trim() !== "") out.push({ page: p.pdf_page, blockId: b.block_id, text: b.text });
  return out;
}

/** In-house BM25 (k1 1.5, b 0.75). Top `k` passages with a positive score, best first. */
export function bm25(passages: readonly Passage[], query: string, k = 5): Hit[] {
  const docs = passages.map((p) => tokens(p.text));
  const n = docs.length;
  if (n === 0) return [];
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  const hits: Hit[] = [];
  docs.forEach((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * 2.5) / (f + 1.5 * (0.25 + (0.75 * d.length) / avg));
    }
    if (score > 0) hits.push({ ...(passages[i] as Passage), score });
  });
  return hits.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, k);
}

export async function retrieve(artifacts: ArtifactStore, runId: string, query: string, k = 5): Promise<Hit[]> {
  return bm25(await loadPassages(artifacts, runId), query, k);
}
