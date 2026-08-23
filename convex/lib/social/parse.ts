// Pure. Pulling text out of a social platform's public HTML or oEmbed JSON.
//
// Everything this module returns is UNTRUSTED — it is whatever a stranger
// wrote in a caption. It reaches a prompt through AIRequest.untrusted and
// never through `input`. Nothing here interprets markup; the parsers below
// extract attribute VALUES and decode entities, and no output of theirs is
// ever treated as HTML again.

export interface MetaTags {
  title?: string;
  description?: string;
  images: string[];
}

/**
 * The five entities that actually appear in og: attribute values. A full
 * entity table is not needed and would invite treating this as an HTML
 * parser, which it is not.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    // Hex form. Instagram captions use it for em dashes and emoji, and an
    // undecoded "&#x2014;" in the middle of a sentence is very visible.
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" rather than "<".
    .replace(/&amp;/g, "&");
}

/** Strip <script> and <style> before scanning: their contents are code, and a
 *  string inside one that LOOKS like a meta tag is not one. */
function withoutScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
}

const META_TAG = /<meta\b[^>]*>/gi;

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return match?.[1];
}

/**
 * og: tags, with twitter: as a fallback.
 *
 * This is the whole of what a public post page reliably exposes without a
 * session. For a carousel it is usually the cover image and the caption —
 * which is precisely why the caller has to be honest about the rest.
 */
export function parseMetaTags(html: string): MetaTags {
  const images: string[] = [];
  let title: string | undefined;
  let description: string | undefined;

  for (const tag of withoutScripts(html).match(META_TAG) ?? []) {
    // property= is the OpenGraph spelling, name= is the Twitter-card one.
    const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const content = attr(tag, "content");
    if (!key || content === undefined) continue;

    const value = decodeEntities(content).trim();
    if (!value) continue;

    if (key === "og:title" || (key === "twitter:title" && !title)) title = value;
    else if (key === "og:description" || (key === "twitter:description" && !description)) {
      description = value;
    } else if (key === "og:image" || key === "og:image:secure_url") {
      // https only, same rule as urlGuard — an http image URL is not worth
      // the downgrade and these platforms all serve https.
      if (value.startsWith("https://") && !images.includes(value)) images.push(value);
    }
  }

  return { ...(title ? { title } : {}), ...(description ? { description } : {}), images };
}

export interface OEmbed {
  title?: string;
  authorName?: string;
  thumbnailUrl?: string;
  html?: string;
}

export function parseOEmbed(body: string): OEmbed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const o = parsed as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);

  return {
    title: str("title"),
    authorName: str("author_name"),
    thumbnailUrl: str("thumbnail_url"),
    html: str("html"),
  };
}

/**
 * X's oEmbed returns the tweet as an HTML blockquote. The text is what we
 * want; the markup, the author line and the permalink are chrome.
 */
export function stripTweetHtml(html: string): string {
  if (!html) return "";

  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const inner = paragraph?.[1] ?? html;

  return decodeEntities(
    inner
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&mdash;[\s\S]*$/, ""),
  ).trim();
}
