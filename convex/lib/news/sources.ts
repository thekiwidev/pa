// Pure. The source catalogue: what each kind needs, how to build its request,
// how to read its answer. A source is "configured" by the presence of its key;
// an absent key means skip, never an error. The connector only fetches.

import {
  parseDailyDev,
  parseDevto,
  parseHn,
  parseLobsters,
  parseRss,
  parseStackExchange,
  type NewsCandidate,
} from "./normalize";

export const SOURCE_KINDS = [
  "hn", "lobsters", "devto", "dailydev", "reddit", "stackexchange", "rss", "gnews", "newsletter",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceConfig {
  /** rss: the feed. */
  url?: string;
  /** Display name for rss / gnews / newsletter / reddit. */
  label?: string;
  /** gnews: search words. */
  query?: string;
  /** reddit: subreddit name without r/. */
  subreddit?: string;
  /** newsletter: sender address or "@domain". */
  sender?: string;
}

export interface SourceSpec {
  kind: SourceKind;
  config: SourceConfig;
}

/** Seeded once; the owner's own additions are marked addedBy "owner". */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [
  { kind: "hn", config: {} },
  { kind: "lobsters", config: {} },
  { kind: "devto", config: {} },
  { kind: "stackexchange", config: {} },
  { kind: "gnews", config: { label: "Google News", query: "technology" } },
  // TLDR's category feed is third-party listed: verify it, the source simply yields nothing if it is gone.
  { kind: "rss", config: { label: "TLDR", url: "https://tldr.tech/api/rss/tech" } },
  { kind: "dailydev", config: {} },
  { kind: "reddit", config: { subreddit: "programming", label: "r/programming" } },
];

type Env = Record<string, string | undefined>;

/** False when the source needs a key that is not set. */
export function sourceConfigured(kind: SourceKind, env: Env): boolean {
  if (kind === "dailydev") return Boolean(env.DAILYDEV_TOKEN);
  if (kind === "reddit") return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
  return true;
}

export function sourceName(spec: SourceSpec): string {
  const { kind, config } = spec;
  switch (kind) {
    case "hn": return "Hacker News";
    case "lobsters": return "Lobsters";
    case "devto": return "DEV";
    case "dailydev": return "daily.dev";
    case "stackexchange": return "Stack Overflow";
    case "reddit": return config.label ?? `r/${config.subreddit ?? "?"}`;
    case "gnews": return config.label ?? "Google News";
    case "newsletter": return config.label ?? config.sender ?? "Newsletter";
    case "rss": return config.label ?? (config.url ? new URL(config.url).hostname : "RSS");
  }
}

export interface SourceRequest {
  url: string;
  headers: Record<string, string>;
  parse: (body: string) => NewsCandidate[];
}

/**
 * The request for sources that are one plain GET. Reddit (OAuth) and
 * newsletter (reads mail) are not here. `topic` narrows the search sources
 * for "what's new in AI agents".
 */
export function buildRequest(spec: SourceSpec, env: Env, topic?: string): SourceRequest | null {
  const name = sourceName(spec);
  const q = topic?.trim();
  switch (spec.kind) {
    case "hn":
      return {
        url: q
          ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=30`
          : "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40",
        headers: {},
        parse: parseHn,
      };
    case "lobsters":
      return { url: "https://lobste.rs/hottest.json", headers: {}, parse: parseLobsters };
    case "devto": {
      const tag = q && /^[\p{L}\p{N}]+$/u.test(q) ? `&tag=${encodeURIComponent(q.toLowerCase())}` : "";
      return { url: `https://dev.to/api/articles?top=2&per_page=30${tag}`, headers: {}, parse: parseDevto };
    }
    case "stackexchange": {
      const key = env.STACKEXCHANGE_KEY ? `&key=${encodeURIComponent(env.STACKEXCHANGE_KEY)}` : "";
      const search = q ? `&intitle=${encodeURIComponent(q)}` : "";
      return {
        url: `https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&site=stackoverflow&pagesize=20${search}${key}`,
        headers: {},
        parse: parseStackExchange,
      };
    }
    case "gnews": {
      const words = q || spec.config.query || "technology";
      return {
        url: `https://news.google.com/rss/search?q=${encodeURIComponent(`${words} when:2d`)}&hl=en-US&gl=US&ceid=US:en`,
        headers: {},
        parse: (body) => parseRss(body, name),
      };
    }
    case "dailydev":
      return env.DAILYDEV_TOKEN
        ? {
            url: "https://api.daily.dev/public/v1/feeds/foryou",
            headers: { Authorization: `Bearer ${env.DAILYDEV_TOKEN}` },
            parse: parseDailyDev,
          }
        : null;
    case "rss":
      return spec.config.url ? { url: spec.config.url, headers: {}, parse: (body) => parseRss(body, name) } : null;
    case "reddit":
    case "newsletter":
      return null;
  }
}

/** Does a mail sender match a newsletter source's `sender` ("a@b.com" or "@b.com")? */
export function senderMatches(pattern: string, fromAddress: string): boolean {
  const p = pattern.trim().toLowerCase();
  const from = fromAddress.trim().toLowerCase();
  if (!p || !from) return false;
  return p.startsWith("@") ? from.endsWith(p) : from === p;
}
