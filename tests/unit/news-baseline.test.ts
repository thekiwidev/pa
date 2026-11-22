import { describe, expect, test } from "bun:test";
import { BASELINE_TOPICS, LAUNCH_QUERIES, launchQueries } from "../../convex/lib/news/baseline";

describe("launch watch", () => {
  test("baseline topics are short phrases", () => {
    expect(BASELINE_TOPICS.length).toBeGreaterThan(3);
    for (const t of BASELINE_TOPICS) expect(t.split(" ").length).toBeLessThanOrEqual(6);
  });
  test("queries add at most three owner topics, positive and explicit first, no repeats", () => {
    const q = launchQueries([
      { topic: "rust", weight: 1, origin: "explicit", createdAt: 0 },
      { topic: "crypto", weight: -1, origin: "explicit", createdAt: 0 },
      { topic: "learned thing", weight: 0.6, origin: "inferred", createdAt: 0 },
      { topic: "rust", weight: 1, origin: "explicit", createdAt: 0 },
      { topic: "go", weight: 1, origin: "explicit", createdAt: 0 },
      { topic: "zig", weight: 1, origin: "explicit", createdAt: 0 },
      { topic: "deno", weight: 1, origin: "explicit", createdAt: 0 },
    ], 0);
    expect(q.slice(0, LAUNCH_QUERIES.length)).toEqual([...LAUNCH_QUERIES]);
    const extra = q.slice(LAUNCH_QUERIES.length);
    expect(extra).toHaveLength(3);
    expect(extra.some((x) => x.includes("crypto"))).toBe(false);
    expect(extra.some((x) => x.includes("learned"))).toBe(false);
  });
});
