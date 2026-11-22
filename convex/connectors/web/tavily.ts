// Tavily search. One POST, key from TAVILY_API_KEY. Returns [] never: a missing
// key or a failed call throws, so the owner hears "search is not set up" rather
// than "nothing found".

import { buildSearchBody, parseSearch, TAVILY_SEARCH_URL, type SearchOptions, type SearchResult } from "../../lib/web/search";

const TIMEOUT_MS = 15_000;

export async function tavilySearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("web search is not set up (TAVILY_API_KEY is missing)");
  const res = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildSearchBody(query, options)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429 || res.status === 432 || res.status === 433) {
    throw new Error("the web search quota is used up for now");
  }
  if (!res.ok) throw new Error(`web search failed (${res.status})`);
  return parseSearch(await res.json());
}
