// Fetching public post metadata. The only place in this project that fetches
// a host chosen by anything other than a constant — every request goes
// through lib/net/urlGuard.ts first.
//
// WHAT IS AND IS NOT REACHABLE, honestly:
//
//   X / Twitter  — publish.twitter.com/oembed returns the full tweet text
//                  with no auth. Reliable.
//   TikTok       — its public oEmbed returns the caption and cover image.
//                  Reliable. Individual slides of a photo post are not
//                  exposed.
//   LinkedIn     — og: tags on a public post carry a truncated caption.
//                  Often works; posts behind a login do not.
//   Instagram    — og: tags carry the caption and the COVER image. Slides 2+
//                  of a carousel need an authenticated session and are not
//                  available. This is a platform decision, not a gap here.
//   Facebook     — og: tags when the post is public, which many are not.
//
// A paid scraping provider would do better on all five. The seam for one is
// `PROVIDER` below: adding it is an env var plus a branch, per invariant 6.

import { MAX_REDIRECTS, MAX_RESPONSE_BYTES, assertFetchable, assertWebUrl } from "../../lib/net/urlGuard";
import { readCapped, readCappedText } from "../../lib/net/stream";
import { parseJina, parseRedditThread, redditApiPath } from "../../lib/social/more";
import { parseMetaTags, parseOEmbed, stripTweetHtml } from "../../lib/social/parse";
import type { DetectedLink } from "../../lib/social/detect";
import {
  instagramShortcode,
  parseApifyInstagram,
  parseFxTwitter,
  parseInstagramEmbed,
  parseApifyTiktok,
  parseTiktokPage,
  parseTikwm,
  isTiktokShortLink,
  tiktokVideoUrl,
  tweetIdFromUrl,
  type FullPost,
} from "../../lib/social/sources";

export interface FetchedPost {
  platform: string;
  url: string;
  /** The post's own words. This is UNTRUSTED content. */
  caption?: string;
  authorName?: string;
  /** Image URLs the platform exposed. Usually just the cover. */
  images: string[];
  /**
   * Set when the post is a carousel whose later slides we cannot reach. The
   * caller turns this into "send me screenshots" rather than presenting one
   * slide as the whole post.
   */
  slidesUnavailable: boolean;
  /** Why a fetch came back thin, in words the user can act on. */
  note?: string;
}

/**
 * An honest, self-identifying crawler UA.
 *
 * Measured 2026-08-23, and it is the opposite of the obvious guess: Instagram
 * serves og: tags to a BOT-shaped user agent and a login wall to a browser
 * one. og: tags exist to be read by link-preview crawlers, so asking as a
 * crawler is the intended path, not a bypass — and an honest string works as
 * well as impersonating facebookexternalhit, which was tested and rejected as
 * unnecessary.
 */
const UA = "PersonalAssistantBot/1.0 (+link preview)";

const TIMEOUT_MS = 10_000;

/**
 * Fetch with the guard applied to the initial URL AND to every redirect hop.
 *
 * `redirect: "manual"` rather than "follow" is the point: a permitted host
 * that 302s to 169.254.169.254 would otherwise be followed automatically,
 * which is the SSRF hole the allowlist exists to close.
 */
async function guardedFetch(startUrl: URL, extraHeaders: Record<string, string> = {}): Promise<string> {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9", ...extraHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A redirect hop must not carry credentials to a new host.
    if (res.status >= 300 && res.status < 400) extraHeaders = {};

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${url.hostname} redirected with no destination`);
      // Re-vet the destination. A redirect is a new request to a new host.
      url = assertFetchable(new URL(location, url).toString());
      continue;
    }

    if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);

    // Read the stream and stop at the cap: res.text() would buffer the whole
    // body before any size check could run.
    return await readCappedText(res.body, MAX_RESPONSE_BYTES);
  }

  throw new Error("that link redirected too many times");
}

async function fetchOEmbed(endpoint: string): Promise<ReturnType<typeof parseOEmbed>> {
  try {
    return parseOEmbed(await guardedFetch(assertFetchable(endpoint)));
  } catch {
    return null;
  }
}

export async function fetchPost(link: DetectedLink): Promise<FetchedPost> {
  const url = assertFetchable(link.canonicalUrl);

  // X: oEmbed gives the full tweet text, which og: tags truncate.
  if (link.platform === "x") {
    const oembed = await fetchOEmbed(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.toString())}&omit_script=1`,
    );
    const text = oembed?.html ? stripTweetHtml(oembed.html) : "";
    if (text) {
      return {
        platform: link.platform,
        url: link.canonicalUrl,
        caption: text,
        authorName: oembed?.authorName,
        images: [],
        slidesUnavailable: false,
      };
    }
    // Fall through to og: tags — a protected or deleted post has no oEmbed.
  }

  // TikTok: public oEmbed gives caption + cover.
  if (link.platform === "tiktok") {
    const oembed = await fetchOEmbed(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(tiktokVideoUrl(url.toString()))}`,
    );
    if (oembed?.title) {
      return {
        platform: link.platform,
        url: link.canonicalUrl,
        caption: oembed.title,
        authorName: oembed.authorName,
        images: oembed.thumbnailUrl ? [oembed.thumbnailUrl] : [],
        slidesUnavailable: false,
        note: "TikTok exposes the caption and cover image only — not the individual slides.",
      };
    }
  }

  const meta = parseMetaTags(await guardedFetch(url));

  // Instagram's og:title is "Name on Instagram: \"caption\"" when it exists at
  // all — measured, many posts expose only og:image and no caption, so the
  // picture is the whole content and OCR is the entire value.
  const caption = meta.description ?? meta.title;

  const slidesUnavailable = link.carouselNeedsLogin && meta.images.length <= 1;

  return {
    platform: link.platform,
    url: link.canonicalUrl,
    caption,
    images: meta.images,
    slidesUnavailable,
    note: slidesUnavailable
      ? `${link.platform} serves only the cover image publicly — further slides need a logged-in session.`
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Saved posts (2026-10-15): the FULL post, not just og: tags.
//
//   X          FxTwitter's public JSON (no key): text, every photo, video
//              variants, the quoted tweet. Falls back to oEmbed + og:.
//   Instagram  Apify's Instagram scraper when APIFY_TOKEN is set: caption
//              and EVERY carousel slide, plus reel video. Then Instagram's
//              own /embed/captioned/ page, then og: (cover only).
//
// Both third parties are behind env vars and a provider name on the result
// (invariant 6); nothing upstream knows which one answered.
// ─────────────────────────────────────────────────────────────────────────


export interface FetchedFullPost extends FullPost {
  platform: string;
  url: string;
  provider:
    | "fxtwitter"
    | "apify"
    | "embed"
    | "og"
    | "oembed"
    | "tiktok-page"
    | "tikwm"
    | "jina"
    | "reddit"
    | "youtube-oembed";
  /** True when we know slides exist that we could not get. */
  slidesUnavailable: boolean;
  note?: string;
}

async function fetchFxTwitter(id: string): Promise<FullPost | null> {
  try {
    const body = await guardedFetch(assertFetchable(`https://api.fxtwitter.com/status/${id}`));
    return parseFxTwitter(body);
  } catch {
    return null;
  }
}

/** Apify's API is a fixed host chosen by config, not by a link, so it is not urlGuard'ed. */
async function fetchApifyInstagram(url: string): Promise<FullPost | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  const actor = process.env.APIFY_INSTAGRAM_ACTOR ?? "apify~instagram-scraper";
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=100`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ directUrls: [url], resultsType: "details", resultsLimit: 1, addParentData: false }),
        signal: AbortSignal.timeout(115_000),
      },
    );
    if (!res.ok) throw new Error(`apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseApifyInstagram(await res.text());
  } catch (error) {
    console.warn(`apify_instagram_failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

async function fetchApifyTiktok(url: string): Promise<FullPost | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  const actor = process.env.APIFY_TIKTOK_ACTOR ?? "clockworks~tiktok-scraper";
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=100`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          postURLs: [tiktokVideoUrl(url)],
          resultsPerPage: 1,
          shouldDownloadSlideshowImages: true,
          shouldDownloadVideos: true,
          shouldDownloadCovers: false,
          shouldDownloadSubtitles: false,
        }),
        signal: AbortSignal.timeout(115_000),
      },
    );
    if (!res.ok) throw new Error(`apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseApifyTiktok(await res.text());
  } catch (error) {
    console.warn(`apify_tiktok_failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

async function fetchTiktokPage(url: string): Promise<FullPost | null> {
  try {
    return parseTiktokPage(await guardedFetch(assertFetchable(url)));
  } catch {
    return null;
  }
}

/** Public reader; `TIKWM=off` stops the bot sending TikTok links to it. */
async function fetchTikwm(url: string): Promise<FullPost | null> {
  if (process.env.TIKWM === "off") return null;
  try {
    const body = await guardedFetch(
      assertFetchable(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(tiktokVideoUrl(url))}`),
    );
    return parseTikwm(body);
  } catch {
    return null;
  }
}

async function fetchInstagramEmbed(shortcode: string): Promise<FullPost | null> {
  try {
    const html = await guardedFetch(
      assertFetchable(`https://www.instagram.com/p/${shortcode}/embed/captioned/`),
    );
    return parseInstagramEmbed(html);
  } catch {
    return null;
  }
}

/** Where a link redirects to (one hop, guarded), or null. */
async function resolveRedirect(rawUrl: string): Promise<string | null> {
  try {
    const url = assertFetchable(rawUrl);
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    const location = res.headers.get("location");
    return location ? assertFetchable(new URL(location, url).toString()).toString() : null;
  } catch {
    return null;
  }
}

/**
 * Any page, through the reader proxy (Jina Reader). We never contact the
 * page's own host: r.jina.ai fetches it and returns markdown. JINA_API_KEY is
 * optional (a key raises the rate limit); without one the keyless tier is used.
 */
export async function fetchViaJina(rawUrl: string): Promise<FullPost | null> {
  try {
    const target = assertWebUrl(rawUrl).toString();
    const key = process.env.JINA_API_KEY;
    const body = await guardedFetch(assertFetchable(`https://r.jina.ai/${target}`), {
      Accept: "application/json",
      "X-Return-Format": "markdown",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    });
    const page = parseJina(body);
    if (!page) return null;
    const heading = page.title ? `${page.title}\n\n` : "";
    // Image URLs are not downloaded for arbitrary sites: images: [] below.
    return { caption: `${heading}${page.markdown}`, images: [], videos: [] };
  } catch (error) {
    console.warn(`jina_failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Reddit's OAuth app (script type, free). Absent keys mean "skip", never an error. */
async function fetchRedditThread(rawUrl: string): Promise<FullPost | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const post = /redd\.it\//.test(rawUrl) ? ((await resolveRedirect(rawUrl)) ?? rawUrl) : rawUrl;
    const path = redditApiPath(post);
    if (!path) return null;
    const ua = "PersonalAssistantBot/1.0 (read-only; personal use)";
    const tokenRes = await fetch(assertFetchable("https://www.reddit.com/api/v1/access_token").toString(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ua,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new Error(`reddit token ${tokenRes.status}`);
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) throw new Error("reddit returned no access_token");
    const body = await guardedFetch(
      assertFetchable(`https://oauth.reddit.com${path}.json?raw_json=1&limit=20&depth=1`),
      { Authorization: `Bearer ${token}`, "User-Agent": ua },
    );
    return parseRedditThread(body);
  } catch (error) {
    console.warn(`reddit_failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Threads: tokenless oEmbed first, then the page's og: tags. */
async function fetchThreads(url: string): Promise<FullPost | null> {
  const oembed = await fetchOEmbed(`https://graph.threads.net/v1.0/oembed?url=${encodeURIComponent(url)}`);
  const text = oembed?.html ? stripTweetHtml(oembed.html) : (oembed?.title ?? "");
  if (text) return { caption: text, author: oembed?.authorName, images: [], videos: [] };
  return null;
}

/** YouTube: oEmbed for title and channel, the watch page's og:description for the text. */
async function fetchYoutube(url: string): Promise<FullPost | null> {
  const oembed = await fetchOEmbed(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  if (!oembed?.title) return null;
  let description: string | undefined;
  try {
    description = parseMetaTags(await guardedFetch(assertFetchable(url))).description;
  } catch {
    // The title alone is still worth saving.
  }
  return {
    caption: [oembed.title, description].filter(Boolean).join("\n\n"),
    author: oembed.authorName,
    images: [],
    videos: [],
  };
}

export async function fetchFullPost(link: DetectedLink): Promise<FetchedFullPost> {
  const base = { platform: link.platform, url: link.canonicalUrl };

  if (link.platform === "web") {
    const page = await fetchViaJina(link.canonicalUrl);
    if (page?.caption) return { ...base, ...page, provider: "jina", slidesUnavailable: false };
    return {
      ...base,
      images: [],
      videos: [],
      provider: "jina",
      slidesUnavailable: false,
      note: "I couldn't read that page (it may be behind a login, or the reader is busy).",
    };
  }

  if (link.platform === "reddit") {
    const thread = await fetchRedditThread(link.canonicalUrl);
    if (thread?.caption) return { ...base, ...thread, provider: "reddit", slidesUnavailable: false };
    // No Reddit keys, or Reddit refused: the reader proxy sees the public page.
    const page = await fetchViaJina(link.canonicalUrl);
    if (page?.caption) return { ...base, ...page, provider: "jina", slidesUnavailable: false };
  }

  if (link.platform === "threads") {
    const post = await fetchThreads(link.canonicalUrl);
    if (post) return { ...base, ...post, provider: "oembed", slidesUnavailable: false };
  }

  if (link.platform === "youtube") {
    const video = await fetchYoutube(link.canonicalUrl);
    if (video) {
      return {
        ...base,
        ...video,
        provider: "youtube-oembed",
        slidesUnavailable: false,
        note: "I can read a YouTube video's title and description, not watch it.",
      };
    }
  }

  if (link.platform === "x") {
    const id = tweetIdFromUrl(link.canonicalUrl);
    const fx = id ? await fetchFxTwitter(id) : null;
    if (fx && (fx.caption || fx.images.length > 0)) {
      return { ...base, ...fx, provider: "fxtwitter", slidesUnavailable: false };
    }
  }

  if (link.platform === "instagram") {
    // "Share" links (instagram.com/share/reel/<code>) redirect to the real
    // post; neither the embed page nor the shortcode work on the share code.
    const postUrl = /\/share\//.test(link.canonicalUrl)
      ? ((await resolveRedirect(link.canonicalUrl)) ?? link.canonicalUrl)
      : link.canonicalUrl;
    const viaApify = await fetchApifyInstagram(postUrl);
    if (viaApify && (viaApify.images.length > 0 || viaApify.caption)) {
      return { ...base, ...viaApify, provider: "apify", slidesUnavailable: false };
    }
    const code = instagramShortcode(postUrl);
    const embed = code ? await fetchInstagramEmbed(code) : null;
    if (embed && (embed.images.length > 1 || (embed.images.length > 0 && embed.caption) || embed.videos.length > 0)) {
      // A reel has one cover by nature; only a carousel can be missing slides.
      const coverOnly = embed.images.length <= 1 && !embed.isVideo;
      return {
        ...base,
        ...embed,
        provider: "embed",
        slidesUnavailable: coverOnly,
        note:
          coverOnly
            ? process.env.APIFY_TOKEN
              ? "Instagram only gave me the cover image this time."
              : "Instagram only shows the cover image without APIFY_TOKEN set."
            : undefined,
      };
    }
  }

  if (link.platform === "tiktok") {
    const postUrl = isTiktokShortLink(link.canonicalUrl)
      ? ((await resolveRedirect(link.canonicalUrl)) ?? link.canonicalUrl)
      : link.canonicalUrl;
    const usable = (p: FullPost | null): p is FullPost =>
      Boolean(p && (p.images.length > 1 || p.videos.length > 0 || (p.images.length > 0 && p.caption)));

    const viaApify = await fetchApifyTiktok(postUrl);
    if (usable(viaApify)) return { ...base, ...viaApify, provider: "apify", slidesUnavailable: false };

    const viaPage = await fetchTiktokPage(postUrl);
    if (usable(viaPage)) return { ...base, ...viaPage, provider: "tiktok-page", slidesUnavailable: false };

    const viaTikwm = await fetchTikwm(postUrl);
    if (usable(viaTikwm)) return { ...base, ...viaTikwm, provider: "tikwm", slidesUnavailable: false };
    // Then oEmbed below: caption and cover only, and it says so.
  }

  // Everything else, and the last resort for the two above: today's path.
  const thin = await fetchPost(link);
  return {
    ...base,
    caption: thin.caption,
    author: thin.authorName,
    images: thin.images,
    videos: [],
    provider: link.platform === "x" ? "oembed" : "og",
    slidesUnavailable: thin.slidesUnavailable,
    note: thin.note,
  };
}

/**
 * Download one media file through the guard, re-vetting every redirect.
 * Returns null when it is too big or unreachable; the caller says so.
 */
export async function fetchMedia(
  rawUrl: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    let url = assertFetchable(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url.toString(), {
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return null;
        url = assertFetchable(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await res.body?.cancel();
        return null;
      }
      // Stream with the cap: a missing or lying content-length must not let
      // an oversized file be buffered whole.
      const { bytes, truncated } = await readCapped(res.body, maxBytes);
      if (truncated) return null;
      return { bytes, mimeType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
    }
    return null;
  } catch {
    return null;
  }
}
