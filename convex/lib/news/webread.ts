// Pure. Which URLs web.read may open, and which links on a page it may offer
// to follow. An exfiltration shape exists here (a URL can carry data in its
// path), so the rule is: the owner chose the site. A URL found on a page is
// followable only inside the registrable domain of a URL the owner sent.

import { httpsHost, registrableDomain } from "../email/links";
import { urlKey } from "./normalize";

export const MAX_WEB_READ_PAGES = 4;
export const MAX_OFFERED_LINKS = 20;

const domainOf = (url: string): string | null => {
  const host = httpsHost(url);
  return host ? registrableDomain(host) : null;
};

/**
 * "owner": the owner sent exactly this URL. "same-domain": a further page of
 * a site the owner sent. null: refuse.
 */
export function webReadVerdict(proposed: string, ownerUrls: readonly string[]): "owner" | "same-domain" | null {
  const key = urlKey(proposed);
  if (ownerUrls.some((u) => urlKey(u) === key)) return "owner";
  const domain = domainOf(proposed);
  if (!domain) return null;
  return ownerUrls.some((u) => domainOf(u) === domain) ? "same-domain" : null;
}

/** https links in markdown, restricted to the page's own registrable domain. */
export function sameDomainLinks(markdown: string, pageUrl: string): { text: string; url: string }[] {
  const domain = domainOf(pageUrl);
  if (!domain) return [];
  const seen = new Set<string>([urlKey(pageUrl)]);
  const out: { text: string; url: string }[] = [];
  for (const m of markdown.matchAll(/\[([^\]]{1,120})\]\((https:\/\/[^)\s]+)\)/g)) {
    const url = m[2]!;
    if (domainOf(url) !== domain || seen.has(urlKey(url))) continue;
    seen.add(urlKey(url));
    out.push({ text: m[1]!.replace(/\s+/g, " ").trim(), url });
    if (out.length >= MAX_OFFERED_LINKS) break;
  }
  return out;
}
