// Pure. Web search through Tavily: the request body, reading the answer, the
// daily cap and which result urls web.read may open afterwards.
//
// A search result is external content, so it is data only. The urls it carries
// become openable for a short window (the planner may read a result it just
// saw) but the model never composes a url: web.read matches against the stored
// result set, which keeps the "who chose this url" rule intact.

import { urlKey } from "../news/normalize";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const DEFAULT_DAILY_SEARCHES = 30;
/** How long a search's result urls stay openable by web.read. */
export const RESULT_URL_WINDOW_MS = 30 * 60 * 1000;
export const MAX_RESULTS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ms epoch when the source says so. */
  publishedAt?: number;
}

export interface SearchOptions {
  /** News mode: recent articles, with a publish date. */
  news?: boolean;
  /** News mode only: how far back, in days. */
  days?: number;
  max?: number;
}

export function buildSearchBody(query: string, options: SearchOptions = {}): Record<string, unknown> {
  const max = Math.min(Math.max(options.max ?? 6, 1), MAX_RESULTS);
  return {
    query: query.trim().slice(0, 380),
    topic: options.news ? "news" : "general",
    search_depth: "basic",
    max_results: max,
    include_answer: false,
    ...(options.news ? { days: Math.min(Math.max(options.days ?? 3, 1), 30) } : {}),
  };
}

/** Reads Tavily's answer. Anything that is not an https url with a title is dropped. */
export function parseSearch(raw: unknown): SearchResult[] {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const e = r as Record<string, unknown>;
    if (typeof e.url !== "string" || !e.url.startsWith("https://") || typeof e.title !== "string") continue;
    const key = urlKey(e.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const published = typeof e.published_date === "string" ? Date.parse(e.published_date) : NaN;
    out.push({
      title: e.title.replace(/\s+/g, " ").trim().slice(0, 200),
      url: e.url,
      snippet: typeof e.content === "string" ? e.content.replace(/\s+/g, " ").trim().slice(0, 500) : "",
      ...(Number.isFinite(published) ? { publishedAt: published } : {}),
    });
  }
  return out;
}

/** How many searches remain today, from the times of the searches already made. */
export function searchesLeft(searchTimesMs: readonly number[], nowMs: number, cap: number): number {
  const used = searchTimesMs.filter((t) => nowMs - t < DAY_MS).length;
  return Math.max(0, cap - used);
}

export function dailyCap(env: Record<string, string | undefined>): number {
  const n = Number(env.WEB_SEARCH_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_SEARCHES;
}

/** The urls of searches made within the window, for web.read's allow list. */
export function recentResultUrls(
  searches: readonly { at: number; urls: readonly string[] }[],
  nowMs: number,
): string[] {
  return searches.filter((s) => nowMs - s.at < RESULT_URL_WINDOW_MS).flatMap((s) => [...s.urls]);
}
