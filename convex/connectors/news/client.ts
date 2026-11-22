// The news connector: plain HTTP for the sources, one function per concern.
// Parsing lives in lib/news (pure); this file only fetches. Every hop is vetted
// with assertWebUrl (https, no IP literal, no internal name, no credentials)
// and the body is read as a stream and cut at the cap.

import { assertWebUrl, MAX_REDIRECTS } from "../../lib/net/urlGuard";
import { readCappedText } from "../../lib/net/stream";
import { parseReddit, type NewsCandidate } from "../../lib/news/normalize";
import { buildRequest, sourceConfigured, sourceName, type SourceSpec } from "../../lib/news/sources";
import { discoverFeedUrl, parseRss } from "../../lib/news/normalize";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000;
const UA = "PersonalAssistantBot/1.0 (read-only; personal use)";

export async function fetchBody(rawUrl: string, headers: Record<string, string> = {}): Promise<string> {
  let url = assertWebUrl(rawUrl);
  let extra = headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "application/json, application/rss+xml, application/xml, text/xml, text/html;q=0.8", ...extra },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${url.hostname} redirected with no destination`);
      // A redirect must not carry credentials to a new host.
      extra = {};
      url = assertWebUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);
    return await readCappedText(res.body, MAX_BYTES);
  }
  throw new Error("too many redirects");
}

async function redditHot(subreddit: string): Promise<NewsCandidate[]> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return [];
  const sub = subreddit.replace(/[^A-Za-z0-9_]/g, "");
  if (!sub) return [];
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`reddit token ${tokenRes.status}`);
  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("reddit returned no access_token");
  const body = await fetchBody(`https://oauth.reddit.com/r/${sub}/hot?limit=25&raw_json=1`, {
    Authorization: `Bearer ${token}`,
  });
  return parseReddit(body, sub);
}

/** One source, one fetch. Returns [] for a source that needs a key it lacks; throws on a real failure. */
export async function fetchSource(spec: SourceSpec, topic?: string): Promise<NewsCandidate[]> {
  if (!sourceConfigured(spec.kind, process.env)) return [];
  if (spec.kind === "reddit") return await redditHot(spec.config.subreddit ?? "");
  const req = buildRequest(spec, process.env, topic);
  if (!req) return [];
  return req.parse(await fetchBody(req.url, req.headers));
}

export interface FoundFeed {
  feedUrl: string;
  label: string;
}

/**
 * "watch <site>": the url may be a feed or a page that links one. Tries the
 * url, then its `<link rel=alternate>`, then /feed and /rss on the same host.
 */
export async function findFeed(rawUrl: string): Promise<FoundFeed | null> {
  const start = assertWebUrl(rawUrl);
  const attempts: string[] = [start.toString()];
  const tried = new Set<string>();
  const looksLikeFeed = (body: string) => /<(rss|feed|rdf:RDF)\b/i.test(body.slice(0, 2000));

  while (attempts.length > 0 && tried.size < 5) {
    const next = attempts.shift()!;
    if (tried.has(next)) continue;
    tried.add(next);
    let body: string;
    try {
      body = await fetchBody(next);
    } catch {
      continue;
    }
    if (looksLikeFeed(body)) {
      const label = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([^<\]]{1,80})/i)?.[1]?.trim() || new URL(next).hostname;
      return parseRss(body, label).length > 0 ? { feedUrl: next, label } : null;
    }
    const discovered = discoverFeedUrl(body, next);
    if (discovered) attempts.unshift(discovered);
    else if (tried.size === 1) attempts.push(new URL("/feed", start).toString(), new URL("/rss", start).toString());
  }
  return null;
}

export { sourceName };
