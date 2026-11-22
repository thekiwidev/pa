// Pure. Every news source speaks its own dialect; this module turns each one
// into the same NewsCandidate and de-duplicates across sources. No fetch here:
// the connector passes the response body in, so every parser runs under plain
// `bun test`. Parsers never throw: a changed or broken feed is an empty list.

export interface NewsCandidate {
  title: string;
  url: string;
  source: string;
  /** Popularity as the source counts it (points, reactions, votes). 0 for feeds with none. */
  score: number;
  /** ms epoch; 0 when the source gave no date. */
  publishedAt: number;
  snippet: string;
  /** Filled by the pipeline when titles are embedded. */
  embedding?: number[];
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|igshid$|ref_src$|share$|spm$)/i;

/** The identity of an article: host, path and meaningful query, nothing else. */
export function urlKey(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${host}${path}${params ? `?${params}` : ""}`;
}

function fnv(text: string, seed: number): string {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 64 bits of FNV-1a over the url key: an index key, not a security boundary. */
export function urlHash(raw: string): string {
  const key = urlKey(raw);
  return fnv(key, 0x811c9dc5) + fnv(key, 0x9747b28c);
}

/** Same url from several sources collapses to one row with the best score. */
export function dedupeCandidates(items: NewsCandidate[], alreadySent: ReadonlySet<string> = new Set()): NewsCandidate[] {
  const best = new Map<string, NewsCandidate>();
  for (const item of items) {
    const hash = urlHash(item.url);
    if (alreadySent.has(hash)) continue;
    const have = best.get(hash);
    if (!have || item.score > have.score) best.set(hash, item);
  }
  return [...best.values()];
}

/* ── small helpers ── */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function plain(html: string, max = 240): string {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, max);
}

const isHttps = (u: unknown): u is string => typeof u === "string" && /^https:\/\//i.test(u);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ms = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

/* ── JSON sources ── */

/** Algolia's Hacker News search (`/search?tags=front_page`). */
export function parseHn(body: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  for (const h of list(field(json(body), "hits"))) {
    const title = decode(text(h.title));
    if (!title) continue;
    const url = isHttps(h.url) ? h.url : h.objectID ? `https://news.ycombinator.com/item?id=${String(h.objectID)}` : "";
    if (!url) continue;
    out.push({ title, url, source: "Hacker News", score: num(h.points), publishedAt: ms(h.created_at_i), snippet: "" });
  }
  return out;
}

/** `lobste.rs/hottest.json`. */
export function parseLobsters(body: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  const parsed = json(body);
  for (const s of list(Array.isArray(parsed) ? parsed : [])) {
    const title = decode(text(s.title));
    const url = isHttps(s.url) ? s.url : isHttps(s.comments_url) ? s.comments_url : "";
    if (!title || !url) continue;
    out.push({ title, url, source: "Lobsters", score: num(s.score), publishedAt: ms(s.created_at), snippet: "" });
  }
  return out;
}

/** `dev.to/api/articles`. */
export function parseDevto(body: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  const parsed = json(body);
  for (const a of list(Array.isArray(parsed) ? parsed : [])) {
    const title = decode(text(a.title));
    if (!title || !isHttps(a.url)) continue;
    out.push({ title, url: a.url, source: "DEV", score: num(a.public_reactions_count), publishedAt: ms(a.published_at), snippet: plain(text(a.description)) });
  }
  return out;
}

/** Stack Exchange `/questions` (hot / week). */
export function parseStackExchange(body: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  for (const q of list(field(json(body), "items"))) {
    const title = decode(text(q.title));
    if (!title || !isHttps(q.link)) continue;
    out.push({ title, url: q.link, source: "Stack Overflow", score: num(q.score), publishedAt: ms(q.creation_date), snippet: "" });
  }
  return out;
}

/** daily.dev public API feed. Shape taken from its docs; unverified live. */
export function parseDailyDev(body: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  for (const p of list(field(json(body), "data"))) {
    const title = decode(text(p.title));
    const url = isHttps(p.url) ? p.url : isHttps(p.permalink) ? p.permalink : "";
    if (!title || !url) continue;
    out.push({ title, url, source: "daily.dev", score: num(p.numUpvotes), publishedAt: ms(p.createdAt), snippet: plain(text(p.summary)) });
  }
  return out;
}

/* ── RSS and Atom ── */

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return decode(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function entryLink(block: string): string {
  const atom = [...block.matchAll(/<link\b([^>]*)>/gi)]
    .map((m) => m[1]!)
    .find((attrs) => /href=/i.test(attrs) && (!/rel=/i.test(attrs) || /rel=["']alternate["']/i.test(attrs)));
  if (atom) return decode(atom.match(/href=["']([^"']+)["']/i)?.[1] ?? "");
  return tag(block, "link");
}

/** RSS 2.0 and Atom. `source` is the display name of the feed. */
export function parseRss(xml: string, source = "RSS"): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = plain(tag(block, "title"), 300);
    const url = entryLink(block);
    if (!title || !isHttps(url)) continue;
    const when = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date");
    const body = tag(block, "description") || tag(block, "summary") || tag(block, "content");
    out.push({ title, url, source, score: 0, publishedAt: ms(when), snippet: plain(body) });
  }
  return out;
}

/** `<link rel="alternate" type="application/rss+xml" href=…>` from a page. */
export function discoverFeedUrl(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tagText = m[0];
    if (!/rel=["']?alternate/i.test(tagText)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tagText)) continue;
    const href = tagText.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(decode(href), pageUrl);
      if (resolved.protocol === "https:") return resolved.toString();
    } catch {
      /* try the next link tag */
    }
  }
  return null;
}

/** Reddit `…/hot` listing (OAuth API). Self posts link to the thread. */
export function parseReddit(body: string, subreddit: string): NewsCandidate[] {
  const out: NewsCandidate[] = [];
  const children = field(field(json(body), "data"), "children");
  for (const child of list(children)) {
    const p = field(child, "data") as Record<string, unknown> | undefined;
    if (!p || p.stickied === true) continue;
    const title = decode(text(p.title));
    const thread = typeof p.permalink === "string" ? `https://www.reddit.com${p.permalink}` : "";
    const url = isHttps(p.url) && !/reddit\.com|redd\.it/.test(p.url) ? p.url : thread;
    if (!title || !isHttps(url)) continue;
    out.push({ title, url, source: `r/${subreddit}`, score: num(p.score), publishedAt: ms(p.created_utc), snippet: plain(text(p.selftext)) });
  }
  return out;
}
