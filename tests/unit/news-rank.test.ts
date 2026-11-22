import { describe, expect, test } from "bun:test";
import { INFERRED_HALF_LIFE_MS, cosine, interestWeight, rankCandidates, scoreCandidate, type Interest } from "../../convex/lib/news/rank";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const cand = (title: string, over: Partial<{ score: number; publishedAt: number; source: string }> = {}) => ({
  title, url: `https://x.example/${encodeURIComponent(title)}`, source: over.source ?? "Hacker News", score: over.score ?? 10, publishedAt: over.publishedAt ?? NOW - DAY, snippet: "",
});
const interest = (over: Partial<Interest>): Interest => ({ topic: "rust", weight: 1, origin: "explicit", createdAt: NOW - DAY, ...over });

describe("interestWeight", () => {
  test("explicit interest keeps its weight", () => {
    expect(interestWeight(interest({}), NOW)).toBe(1);
  });
  test("expired interest is zero from the expiry instant", () => {
    const i = interest({ expiresAt: NOW });
    expect(interestWeight(i, NOW - 1)).toBe(1);
    expect(interestWeight(i, NOW)).toBe(0);
  });
  test("one week then day eight: expires on day 8", () => {
    const created = NOW;
    const i = interest({ createdAt: created, expiresAt: created + 7 * DAY });
    expect(interestWeight(i, created + 7 * DAY - 1)).toBe(1);
    expect(interestWeight(i, created + 8 * DAY)).toBe(0);
  });
  test("inferred interest halves every 14 days", () => {
    const i = interest({ origin: "inferred", createdAt: NOW - INFERRED_HALF_LIFE_MS });
    expect(interestWeight(i, NOW)).toBeCloseTo(0.5, 5);
    expect(interestWeight({ ...i, createdAt: NOW - 2 * INFERRED_HALF_LIFE_MS }, NOW)).toBeCloseTo(0.25, 5);
  });
  test("negative interests stay negative and do not decay when explicit", () => {
    expect(interestWeight(interest({ weight: -1 }), NOW + 400 * DAY)).toBe(-1);
  });
});

describe("cosine", () => {
  test("identical 1, orthogonal 0, empty or mismatched 0", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([1], [1, 2])).toBe(0);
  });
});

describe("scoreCandidate / rankCandidates", () => {
  test("an interest keyword in the title lifts a story without embeddings", () => {
    const interests = [interest({ topic: "rust" })];
    const a = scoreCandidate(cand("Rust gets faster"), interests, NOW);
    const b = scoreCandidate(cand("Gardening tips"), interests, NOW);
    expect(a).toBeGreaterThan(b);
  });
  test("embedding similarity drives the match when both vectors exist", () => {
    const interests = [interest({ topic: "x", embedding: [1, 0] })];
    const near = { ...cand("anything"), embedding: [1, 0] };
    const far = { ...cand("anything else"), embedding: [0, 1] };
    expect(scoreCandidate(near, interests, NOW)).toBeGreaterThan(scoreCandidate(far, interests, NOW));
  });
  test("negative interest pushes a story below an unrelated one", () => {
    const interests = [interest({ topic: "crypto", weight: -1 })];
    const crypto = scoreCandidate(cand("Crypto is back"), interests, NOW);
    const other = scoreCandidate(cand("Gardening tips"), interests, NOW);
    expect(crypto).toBeLessThan(other);
  });
  test("expired interest no longer matters", () => {
    const interests = [interest({ topic: "rust", expiresAt: NOW - 1 })];
    expect(scoreCandidate(cand("Rust gets faster"), interests, NOW)).toBeCloseTo(scoreCandidate(cand("Gardening tips"), interests, NOW), 5);
  });
  test("fresher beats older at equal popularity", () => {
    const fresh = scoreCandidate(cand("a", { publishedAt: NOW - 1000 }), [], NOW);
    const old = scoreCandidate(cand("a", { publishedAt: NOW - 6 * DAY }), [], NOW);
    expect(fresh).toBeGreaterThan(old);
  });
  test("popularity is normalized per source, so a 20-point lobster is not buried by a 900-point HN story", () => {
    const list = [cand("hn big", { score: 900, source: "HN" }), cand("hn mid", { score: 400, source: "HN" }), cand("lobster top", { score: 20, source: "Lobsters" }), cand("lobster low", { score: 2, source: "Lobsters" })];
    const ranked = rankCandidates(list, [], NOW);
    const titles = ranked.map((r) => r.title);
    expect(titles.indexOf("lobster top")).toBeLessThan(titles.indexOf("hn mid"));
  });
  test("spreads sources: no source supplies more than half of a top-N when others exist", () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => cand(`hn ${i}`, { score: 500 - i, source: "HN" })),
      ...Array.from({ length: 3 }, (_, i) => cand(`dev ${i}`, { score: 50 - i, source: "DEV" })),
    ];
    const top = rankCandidates(list, [], NOW, { limit: 6 });
    expect(top.filter((t) => t.source === "HN").length).toBeLessThanOrEqual(3);
  });
});

describe("rankCandidates relevance first", () => {
  test("a story that matches an interest outranks a fresher popular one that does not", () => {
    const interests = [interest({ topic: "anthropic claude" })];
    const match = cand("Anthropic launches Claude Duet", { score: 1, publishedAt: NOW - 3 * DAY });
    const noise = cand("My weekend CSS tricks", { score: 900, publishedAt: NOW });
    const out = rankCandidates([noise, match], interests, NOW, { limit: 2 });
    expect(out[0]!.title).toBe(match.title);
  });
  test("with no interests the order is unchanged by the relevance rule", () => {
    const a = cand("older", { score: 5, publishedAt: NOW - 3 * DAY });
    const b = cand("newer", { score: 5, publishedAt: NOW });
    expect(rankCandidates([a, b], [], NOW, { limit: 2 })[0]!.title).toBe("newer");
  });
  test("a negative interest keeps its story below neutral ones", () => {
    const interests = [interest({ topic: "crypto", weight: -1 })];
    const bad = cand("Crypto rallies again", { score: 900, publishedAt: NOW });
    const ok = cand("Plain neutral story", { score: 1, publishedAt: NOW - DAY });
    expect(rankCandidates([bad, ok], interests, NOW, { limit: 2 })[0]!.title).toBe(ok.title);
  });
});
