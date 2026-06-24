/**
 * Math helpers (no IO, no deps) — easy to unit-test.
 */

/**
 * Cosine similarity in [-1, 1]. For L2-normalized vectors (CLIP output)
 * this equals the dot product.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length) return 0;
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function findBestMatch<T extends { embedding: number[] }>(
  target: number[],
  candidates: T[]
): { match: T; score: number; index: number } | null {
  if (!candidates?.length) return null;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    const score = cosineSimilarity(target, c.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return { match: candidates[bestIdx] as T, score: bestScore, index: bestIdx };
}
