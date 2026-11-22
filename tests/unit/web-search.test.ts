import { describe, expect, test } from "bun:test";
import {
  RESULT_URL_WINDOW_MS,
  buildSearchBody,
  dailyCap,
  parseSearch,
  recentResultUrls,
  searchesLeft,
} from "../../convex/lib/web/search";
import { webReadVerdict } from "../../convex/lib/news/webread";

const NOW = 1_800_000_000_000;

describe("buildSearchBody", () => {
  test("general search has no days and clamps results", () => {
    const b = buildSearchBody("  hello  ", { max: 99 });
    expect(b.query).toBe("hello");
    expect(b.topic).toBe("general");
    expect(b.max_results).toBe(8);
    expect("days" in b).toBe(false);
  });
  test("news mode sets topic and bounded days", () => {
    const b = buildSearchBody("claude", { news: true, days: 90 });
    expect(b.topic).toBe("news");
    expect(b.days).toBe(30);
  });
});

describe("parseSearch", () => {
  test("keeps https results, drops http, duplicates and junk", () => {
    const out = parseSearch({
      results: [
        { title: "A", url: "https://a.example/x?utm_source=z", content: "one  two", published_date: "2026-11-20" },
        { title: "A again", url: "https://www.a.example/x" },
        { title: "plain", url: "http://b.example/" },
        { url: "https://c.example/" },
        null,
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.snippet).toBe("one two");
    expect(out[0]!.publishedAt).toBe(Date.parse("2026-11-20"));
  });
  test("garbage input gives an empty list", () => {
    expect(parseSearch(undefined)).toEqual([]);
    expect(parseSearch({ results: "no" })).toEqual([]);
  });
});

describe("daily cap", () => {
  test("counts only the last 24 hours", () => {
    const times = [NOW - 1000, NOW - 25 * 60 * 60 * 1000];
    expect(searchesLeft(times, NOW, 3)).toBe(2);
    expect(searchesLeft(times, NOW, 1)).toBe(0);
  });
  test("env override must be a positive integer", () => {
    expect(dailyCap({})).toBe(30);
    expect(dailyCap({ WEB_SEARCH_DAILY_CAP: "5" })).toBe(5);
    expect(dailyCap({ WEB_SEARCH_DAILY_CAP: "-2" })).toBe(30);
    expect(dailyCap({ WEB_SEARCH_DAILY_CAP: "abc" })).toBe(30);
  });
});

describe("result urls and web.read", () => {
  const searches = [
    { at: NOW - 60_000, urls: ["https://news.example/launch"] },
    { at: NOW - RESULT_URL_WINDOW_MS - 1, urls: ["https://old.example/"] },
  ];
  test("only searches inside the window count", () => {
    expect(recentResultUrls(searches, NOW)).toEqual(["https://news.example/launch"]);
  });
  test("a searched url opens; a composed one does not", () => {
    const allowed = recentResultUrls(searches, NOW);
    expect(webReadVerdict("https://news.example/launch", allowed)).toBe("owner");
    expect(webReadVerdict("https://evil.example/?d=secret", allowed)).toBeNull();
  });
});
