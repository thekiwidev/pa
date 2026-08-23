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

import { MAX_REDIRECTS, MAX_RESPONSE_BYTES, assertFetchable } from "../../lib/net/urlGuard";
import { parseMetaTags, parseOEmbed, stripTweetHtml } from "../../lib/social/parse";
import type { DetectedLink } from "../../lib/social/detect";

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
async function guardedFetch(startUrl: URL): Promise<string> {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${url.hostname} redirected with no destination`);
      // Re-vet the destination. A redirect is a new request to a new host.
      url = assertFetchable(new URL(location, url).toString());
      continue;
    }

    if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);

    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) return body.slice(0, MAX_RESPONSE_BYTES);
    return body;
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
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url.toString())}`,
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
