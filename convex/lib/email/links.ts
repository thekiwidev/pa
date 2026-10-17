// Pure. No ctx, no fetch. Which links in an email alert may be CLICKABLE.
//
// WHY THIS EXISTS
//
// An alert that says "update your payment method" is only half useful without
// the place to do it. But a link in an alert is the most dangerous thing the
// assistant can put on the owner's phone: a phishing mail is, by definition,
// a mail whose link looks right. So the classifier may PROPOSE a link, as
// [label](url) inside its sentence, and code alone decides whether it renders
// as a link at all. The rule is deliberately narrow:
//
//   A link is clickable only when the sender's mail PASSED authentication,
//   is not in SPAM, and the link's host belongs to the sender's own domain
//   (or the same company, e.g. youtube.com for mail from google.com).
//
// Everything else renders as its label, with the address shown as <code> —
// Telegram autolinks a bare "example.com/x" in plain text, but not inside a
// code entity, so a doubtful address is visible and inert.

/** Two-label public suffixes common in the owner's mail. Not the full PSL —
 *  a miss here only makes a host's "registrable domain" one label too short,
 *  which makes matching STRICTER, never looser. */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.ng", "org.ng", "gov.ng", "edu.ng", "net.ng",
  "com.pl", "net.pl", "org.pl",
  "com.au", "co.za", "co.in", "com.br", "co.jp",
]);

/** Companies that send mail from one domain about a product on another. */
const SAME_COMPANY: string[][] = [
  ["google.com", "youtube.com", "gmail.com", "googlemail.com", "android.com"],
  ["microsoft.com", "live.com", "outlook.com", "office.com", "microsoftonline.com", "xbox.com"],
  ["facebookmail.com", "facebook.com", "instagram.com", "meta.com", "whatsapp.com"],
  ["github.com", "githubusercontent.com"],
  ["amazon.com", "amazonaws.com", "aws.amazon.com"],
  ["apple.com", "icloud.com"],
];

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function sameCompany(a: string, b: string): boolean {
  if (a === b) return true;
  return SAME_COMPANY.some((group) => group.includes(a) && group.includes(b));
}

export interface LinkTrustFacts {
  fromAddress: string;
  labelIds: string[];
  authResults?: { spf: string; dkim: string; dmarc: string };
}

function senderAuthenticated(facts: LinkTrustFacts): boolean {
  if (facts.labelIds.includes("SPAM")) return false;
  const auth = facts.authResults;
  if (!auth) return false;
  // DMARC pass is the real proof the From domain is not spoofed. DKIM pass
  // with no DMARC record at all is accepted too — plenty of legitimate small
  // senders publish none — but never alongside a DMARC fail.
  return auth.dmarc === "pass" || (auth.dmarc === "none" && auth.dkim === "pass");
}

/** Host of an https URL, or null for anything else (http, mailto, javascript:…). */
export function httpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null; // https://bank.com@evil.io
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url` may render as a tappable link in an alert for this email. */
export function isTrustedLink(url: string, facts: LinkTrustFacts): boolean {
  const host = httpsHost(url);
  if (!host) return false;
  if (!senderAuthenticated(facts)) return false;
  const senderDomain = registrableDomain(facts.fromAddress.split("@")[1] ?? "");
  if (!senderDomain) return false;
  return sameCompany(registrableDomain(host), senderDomain);
}

export interface EmailLink {
  text: string;
  url: string;
}

const MAX_LINKS = 12;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * The https links in an email, with their visible text, de-duplicated.
 *
 * Read from the HTML because stripping HTML to text throws the hrefs away —
 * which is why the classifier used to see "Update payment method" with no
 * idea where it went. Falls back to bare URLs in the plain-text body.
 */
export function extractLinks(html: string[], plain: string[]): EmailLink[] {
  const out: EmailLink[] = [];
  const seen = new Set<string>();
  const push = (url: string, text: string) => {
    const clean = decodeEntities(url.trim());
    if (!httpsHost(clean) || seen.has(clean) || out.length >= MAX_LINKS) return;
    seen.add(clean);
    out.push({ text: decodeEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80), url: clean.slice(0, 500) });
  };

  for (const doc of html) {
    for (const m of doc.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      push(m[1] ?? "", m[2] ?? "");
    }
  }
  if (out.length === 0) {
    for (const doc of plain) {
      for (const m of doc.matchAll(/https:\/\/[^\s<>"')\]]+/g)) push(m[0], "");
    }
  }
  return out;
}

/**
 * The link facts handed to the classifier (in the UNTRUSTED block — link text
 * is sender-written). Each line says whether code would let it be clickable,
 * so the model is told up front which links it may use.
 */
export function describeLinksForClassifier(links: EmailLink[], facts: LinkTrustFacts): string {
  if (links.length === 0) return "(no links)";
  return links
    .map((l) => {
      const host = httpsHost(l.url) ?? "?";
      const trust = isTrustedLink(l.url, facts) ? "sender's own domain" : "NOT the sender's domain";
      return `- "${l.text || "(no text)"}" → ${l.url} [${host}; ${trust}]`;
    })
    .join("\n");
}

/** Telegram HTML escape. Duplicated from lib/telegram/html.ts on purpose:
 *  this module returns plain strings and the caller brands the result. */
function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const MD_LINK = /\[([^\]\n]{1,120})\]\(([^)\s]{1,600})\)/g;
/** A bare address in prose. The TLD list keeps "Node.js" or "e.g." from
 *  reading as hosts; an unlisted TLD stays plain text, which Telegram may
 *  still autolink — acceptable, because the classifier is told to write
 *  addresses only as [label](url). */
const BARE_URL =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|me|ng|pl|uk|ai|xyz|info|site|online|link|ly|gg|tv|so|sh|us|eu|de|fr|biz|cloud|tech|page)\b(?:\/[^\s<>"')\]]*)?/gi;

/**
 * The classifier's sentence → Telegram HTML, with every link checked.
 *
 * - [label](url) with a trusted url → <a href>.
 * - [label](url) otherwise → the label, then the address as <code>, so the
 *   owner can see where it pointed without being able to tap it.
 * - A bare address in the text → left alone when trusted (Telegram links
 *   it), wrapped in <code> when not.
 */
export function renderSummaryHtml(summary: string, facts: LinkTrustFacts): string {
  const parts: string[] = [];
  let last = 0;
  const plain = (text: string) => {
    parts.push(
      // Escaping cannot have created an address, so matching after it is safe.
      esc(text).replace(BARE_URL, (raw) => {
        // A sentence's own full stop is not part of the address.
        const match = raw.replace(/[.,;:!?]+$/, "");
        const tail = raw.slice(match.length);
        const url = match.startsWith("http") ? match : `https://${match}`;
        return (isTrustedLink(url, facts) ? match : `<code>${match}</code>`) + tail;
      }),
    );
  };

  for (const m of summary.matchAll(MD_LINK)) {
    const index = m.index ?? 0;
    plain(summary.slice(last, index));
    const label = m[1] ?? "";
    const url = m[2] ?? "";
    if (isTrustedLink(url, facts)) {
      parts.push(`<a href="${esc(url).replaceAll('"', "&quot;")}">${esc(label)}</a>`);
    } else {
      const host = httpsHost(url) ?? url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
      parts.push(`${esc(label)} (<code>${esc(host)}</code>)`);
    }
    last = index + m[0].length;
  }
  plain(summary.slice(last));
  return parts.join("");
}

/** The sentence as plain text — links reduced to their labels — for history and briefs. */
export function summaryAsPlainText(summary: string): string {
  return summary.replace(MD_LINK, (_m, label: string, url: string) => `${label} (${url})`);
}
