// Pure. Ordering for the newsletter, with no model call: interest match,
// popularity within the story's own source, and recency. The owner's interests
// can be time-bound ("Rust for two weeks"), learned ("you saved three Rust
// links") and negative ("no more crypto"), so each has a weight that is a
// function of time, evaluated here and never stored.

import type { NewsCandidate } from "./normalize";

export const INFERRED_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_MS = 2 * DAY_MS;

export interface Interest {
  topic: string;
  embedding?: number[];
  /** Positive attracts, negative repels. */
  weight: number;
  /** ms epoch. From this instant the interest counts for nothing. */
  expiresAt?: number;
  origin: "explicit" | "inferred";
  createdAt: number;
}

/** What an interest is worth right now. */
export function interestWeight(interest: Interest, nowMs: number): number {
  if (interest.expiresAt !== undefined && nowMs >= interest.expiresAt) return 0;
  if (interest.origin === "explicit") return interest.weight;
  const age = Math.max(0, nowMs - interest.createdAt);
  return interest.weight * 0.5 ** (age / INFERRED_HALF_LIFE_MS);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}+#.]{2,}/gu) ?? [];

/** 0..1: how much a story is about a topic. Vectors when both exist, words otherwise. */
function match(candidate: NewsCandidate, interest: Interest): number {
  if (candidate.embedding && interest.embedding) {
    // Raw cosine of unrelated text is not 0; only clearly related text counts.
    return Math.max(0, (cosine(candidate.embedding, interest.embedding) - 0.55) / 0.45);
  }
  const topic = words(interest.topic);
  if (topic.length === 0) return 0;
  const title = new Set(words(`${candidate.title} ${candidate.snippet}`));
  return topic.filter((w) => title.has(w)).length / topic.length;
}

const INTEREST_SCALE = 3;

/** Sum of weight x match over the live interests. Positive means "about something they want". */
export function interestMatchScore(candidate: NewsCandidate, interests: Interest[], nowMs: number): number {
  let interestScore = 0;
  for (const i of interests) {
    const w = interestWeight(i, nowMs);
    if (w !== 0) interestScore += w * match(candidate, i);
  }
  return interestScore;
}

/** Higher is better. Popularity is added by rankCandidates (it needs the whole list). */
export function scoreCandidate(candidate: NewsCandidate, interests: Interest[], nowMs: number): number {
  const interestScore = interestMatchScore(candidate, interests, nowMs);
  const age = candidate.publishedAt > 0 ? Math.max(0, nowMs - candidate.publishedAt) : 3 * DAY_MS;
  const recency = 0.5 ** (age / RECENCY_HALF_LIFE_MS);
  return interestScore * INTEREST_SCALE + recency;
}

export interface RankOptions {
  limit?: number;
  /** Most of one source in the result, when other sources can fill the rest. */
  perSourceShare?: number;
}

/**
 * Popularity is a percentile inside the story's own source: 20 points is a top
 * Lobsters story and a middling Hacker News one. The final list caps any one
 * source so one busy feed cannot be the whole newsletter.
 */
export function rankCandidates(
  candidates: NewsCandidate[],
  interests: Interest[],
  nowMs: number,
  options: RankOptions = {},
): NewsCandidate[] {
  const bySource = new Map<string, number[]>();
  for (const c of candidates) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c.score]);
  const percentile = (c: NewsCandidate): number => {
    const scores = bySource.get(c.source) ?? [];
    if (scores.length < 2) return 0.5;
    return scores.filter((s) => s < c.score).length / (scores.length - 1);
  };

  // Relevance first: a story that matches something the owner cares about
  // always ranks above one that does not, however popular or fresh. Without
  // this a 900-point generic post beats the launch they wanted to hear about.
  const scored = candidates
    .map((c) => {
      const interestPart = interestMatchScore(c, interests, nowMs);
      return { c, relevant: interestPart > 0, total: scoreCandidate(c, interests, nowMs) + percentile(c) };
    })
    .sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.total - a.total)
    .map((s) => s.c);

  const limit = options.limit ?? scored.length;
  const maxPerSource = Math.max(1, Math.ceil(limit * (options.perSourceShare ?? 0.5)));
  const picked: NewsCandidate[] = [];
  const counts = new Map<string, number>();
  for (const c of scored) {
    if (picked.length >= limit) break;
    if ((counts.get(c.source) ?? 0) >= maxPerSource) continue;
    counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
    picked.push(c);
  }
  // Fewer sources than the cap allows: fill from what was skipped.
  for (const c of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}
