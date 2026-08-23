// Pure. The gate on fetching a URL a human handed us.
//
// WHY THIS IS ITS OWN MODULE
//
// Every other fetch in this project targets a hardcoded host: Gmail,
// Telegram, four AI providers. Social links are the first time a URL from
// OUTSIDE decides where a request goes, and that is the classic
// server-side-request-forgery shape — a link that looks like a post but
// resolves to a cloud metadata endpoint, a loopback admin page, or an
// internal service that trusts anything on the local network.
//
// The design is an ALLOWLIST, not a denylist. A denylist of bad hosts is a
// losing game (decimal IPs, octal IPs, IPv6-mapped IPv4, unicode homographs,
// redirects, DNS entries pointing at 127.0.0.1); an allowlist of five social
// platforms is a list you can read and be sure about.
//
// KNOWN RESIDUAL RISK, stated rather than hidden: this cannot defend against
// DNS rebinding, because the V8 runtime's `fetch` gives no way to pin a
// resolved address. An attacker who controls DNS for one of the allowed hosts
// could point it inward. That requires compromising Meta, ByteDance, X or
// Microsoft's DNS, at which point this is not the weakest link.

/**
 * Host suffixes we will fetch. A host matches when it EQUALS one of these or
 * is a subdomain of one — never merely ends with the string, which would let
 * "instagram.com.evil.net" through.
 */
const ALLOWED_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "publish.twitter.com",
  "linkedin.com",
  "facebook.com",
  "fb.watch",
] as const;

/** Enough to follow a share-link shortener to its post; not enough to loop. */
export const MAX_REDIRECTS = 3;

/**
 * A post page is HTML we scrape a handful of meta tags out of. 2 MB is
 * generous for that and small against an action's 64 MB budget.
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Equal to an allowed host, or a subdomain of one. */
export function isAllowedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Bare IPv4, including the shortened forms people use to evade filters. */
const IPV4_LIKE = /^\d{1,3}(\.\d{1,3}){0,3}$/;

/**
 * Parse and vet a URL, or throw with a reason the user can read.
 *
 * Returns a parsed URL so the caller fetches THAT rather than the original
 * string — a string can be re-interpreted, a URL object cannot.
 */
export function assertFetchable(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw.slice(0, 80)}" is not a link I can open`);
  }

  // https only. Every allowed platform serves it, and http would expose the
  // request to anyone on the path.
  if (url.protocol !== "https:") {
    throw new Error(`I only open https links — that one is ${url.protocol.replace(":", "")}`);
  }

  // "https://www.instagram.com@evil.example.com/" fetches evil.example.com.
  // The allowlist check below would pass on a naive reading of the string,
  // which is exactly why this is checked separately.
  if (url.username || url.password) {
    throw new Error("that link has credentials embedded in it, which I won't follow");
  }

  const host = url.hostname.toLowerCase();

  // An IP literal can never be one of the allowed platforms, so this is
  // strictly redundant with the allowlist — kept because it fails with a
  // clearer message, and because it is the check a reader looks for.
  if (IPV4_LIKE.test(host) || host.startsWith("[") || host.includes(":")) {
    throw new Error("that link points at a raw IP address, which I won't open");
  }

  if (!isAllowedHost(host)) {
    throw new Error(
      `I can only open links from Instagram, TikTok, X, LinkedIn or Facebook — that one is ${host}`,
    );
  }

  return url;
}
