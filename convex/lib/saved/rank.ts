// Pure. Ranking saved items for a question, and deciding when one is worth
// bringing up unasked.

export interface Hit {
  id: string;
  score: number;
}

/**
 * Reciprocal-rank fusion of the meaning search (vectors) and the word search
 * (full text). Exact names ("Nuclei") come from words; "that open-source
 * vulnerability scanner" comes from meaning. Fusion means neither has to win.
 */
export function fuseHits(vector: Hit[], text: string[], k = 60): Hit[] {
  const scores = new Map<string, number>();
  vector.forEach((h, rank) => scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (k + rank + 1)));
  text.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** Cosine similarity above which an item is "possibly relevant" unasked. */
export const RECALL_THRESHOLD = 0.72;
/** Higher bar for a proactive nudge than for adding context to a reply. */
export const NUDGE_THRESHOLD = 0.78;
export const NUDGE_ITEM_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const NUDGES_PER_DAY = 1;

/**
 * May this item be nudged now? Once a day at most, the same item once a
 * fortnight, and an item the owner said "not now" to needs a stronger match.
 */
export function mayNudge(args: {
  score: number;
  nudgesToday: number;
  lastSurfacedAt?: number;
  downvotes?: number;
  now: number;
}): boolean {
  if (args.nudgesToday >= NUDGES_PER_DAY) return false;
  if (args.lastSurfacedAt !== undefined && args.now - args.lastSurfacedAt < NUDGE_ITEM_COOLDOWN_MS) return false;
  const bar = NUDGE_THRESHOLD + 0.04 * (args.downvotes ?? 0);
  return args.score >= bar;
}

/** Unit-length, so a dot product is a cosine. */
export function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? values : values.map((v) => v / norm);
}
