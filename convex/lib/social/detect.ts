// Pure. Which platform a pasted link belongs to, and its canonical form.

export type Platform = "instagram" | "tiktok" | "x" | "linkedin" | "facebook";

export interface DetectedLink {
  platform: Platform;
  /** Tracking parameters stripped, so two pastes of one post match. */
  canonicalUrl: string;
  /**
   * True when the platform will not serve a carousel's later slides without
   * an authenticated session.
   *
   * Carried here rather than discovered at fetch time so the caller can say
   * "send me screenshots" honestly, instead of returning slide 1 as though it
   * were the whole post. Being wrong quietly is the failure mode worth
   * designing against.
   */
  carouselNeedsLogin: boolean;
}

const HOST_PLATFORM: { suffix: string; platform: Platform }[] = [
  { suffix: "instagram.com", platform: "instagram" },
  { suffix: "tiktok.com", platform: "tiktok" },
  { suffix: "x.com", platform: "x" },
  { suffix: "twitter.com", platform: "x" },
  { suffix: "linkedin.com", platform: "linkedin" },
  { suffix: "facebook.com", platform: "facebook" },
  { suffix: "fb.watch", platform: "facebook" },
];

/** Analytics noise every platform appends to a share link. */
const TRACKING_PARAMS = [
  "igshid",
  "igsh",
  "img_index",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
  "gclid",
  "mibextid",
  "rdid",
  "si",
  "s",
  "t",
  "_r",
  "_t",
  "is_from_webapp",
  "sender_device",
  "web_id",
];

const NEEDS_LOGIN_FOR_CAROUSEL: Platform[] = ["instagram", "facebook", "linkedin"];

export function detectPlatform(raw: string): DetectedLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const hit = HOST_PLATFORM.find((h) => host === h.suffix || host.endsWith(`.${h.suffix}`));
  if (!hit) return null;

  for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  // A query string that is now empty should not leave a dangling "?".
  const query = url.searchParams.toString();
  const canonicalUrl = `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;

  return {
    platform: hit.platform,
    canonicalUrl,
    carouselNeedsLogin: NEEDS_LOGIN_FOR_CAROUSEL.includes(hit.platform),
  };
}

/**
 * URLs inside a message.
 *
 * The trailing-character class deliberately excludes sentence punctuation:
 * "see https://x.com/a." must not capture the full stop, and a link inside
 * parentheses must not capture the closing bracket.
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

export function extractUrls(text: string): string[] {
  const found = text.match(URL_IN_TEXT) ?? [];
  return found.map((u) => u.replace(/[.,;:!?)\]}>]+$/, ""));
}
