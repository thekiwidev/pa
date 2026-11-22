// Pure. Parsers for the Phase 24 readers: Jina Reader (any web page) and
// Reddit's API. Everything returned is UNTRUSTED content: it is whatever a
// stranger wrote. It reaches a prompt through AIRequest.untrusted only.

import type { FullPost } from "./sources";

/** A page is read for its gist; past this the tail is dropped. */
export const MAX_PAGE_CHARS = 60_000;

export interface ReadPage {
  title?: string;
  url?: string;
  /** The page as markdown. */
  markdown: string;
  /** Image URLs found on the page. Stored as links only, never downloaded. */
  images: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * Jina Reader's answer. Two shapes are in the wild: JSON when asked with
 * `Accept: application/json` (`{code, data: {title, url, content, images}}`)
 * and plain text ("Title: …\n\nURL Source: …\n\nMarkdown Content:\n…").
 * Both are read; an error or an empty page is null.
 */
export function parseJina(body: string): ReadPage | null {
  const text = body.trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const root = obj(json);
    if (!root) return null;
    if (typeof root.code === "number" && root.code >= 400) return null;
    const data = obj(root.data);
    const markdown = str(data?.content);
    if (!data || !markdown) return null;
    const images: string[] = [];
    const raw = data.images;
    const list = Array.isArray(raw) ? raw : obj(raw) ? Object.values(raw as object) : [];
    for (const u of list) {
      const url = str(u);
      if (url && /^https:\/\//.test(url) && !images.includes(url)) images.push(url);
    }
    return {
      ...(str(data.title) ? { title: str(data.title)! } : {}),
      ...(str(data.url) ? { url: str(data.url)! } : {}),
      markdown: markdown.slice(0, MAX_PAGE_CHARS),
      images: images.slice(0, 20),
    };
  }

  const marker = "Markdown Content:";
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const head = text.slice(0, at);
  const markdown = text.slice(at + marker.length).trim();
  if (!markdown) return null;
  const title = /^Title:\s*(.+)$/m.exec(head)?.[1]?.trim();
  const url = /^URL Source:\s*(\S+)/m.exec(head)?.[1];
  const images = [...markdown.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((u, i, all) => all.indexOf(u) === i)
    .slice(0, 20);
  return { ...(title ? { title } : {}), ...(url ? { url } : {}), markdown: markdown.slice(0, MAX_PAGE_CHARS), images };
}

/**
 * The API path for a Reddit post link, or null when it is not a post.
 *   https://www.reddit.com/r/rust/comments/abc123/some_title/ -> /r/rust/comments/abc123
 *   https://redd.it/abc123                                    -> /comments/abc123
 */
export function redditApiPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "redd.it") {
    const id = /^\/([a-z0-9]{4,10})\/?$/i.exec(url.pathname)?.[1];
    return id ? `/comments/${id}` : null;
  }
  const m = /^(\/r\/[A-Za-z0-9_]+)?\/comments\/([a-z0-9]{4,10})(?:\/|$)/i.exec(url.pathname);
  return m ? `${m[1] ?? ""}/comments/${m[2]}` : null;
}

const MAX_COMMENTS = 8;

/**
 * A Reddit thread listing pair: [post, comments]. Caption = subreddit, title,
 * body and the top few comments, because the answer is often in them.
 */
export function parseRedditThread(body: string): FullPost | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const listing = obj(obj(json[0])?.data)?.children;
  const post = obj(obj(Array.isArray(listing) ? listing[0] : undefined)?.data);
  const title = str(post?.title);
  if (!post || !title) return null;

  const lines = [`r/${str(post.subreddit) ?? "?"}: ${title}`];
  const selftext = str(post.selftext);
  if (selftext) lines.push("", selftext);
  const link = str(post.url_overridden_by_dest);
  if (link && !/reddit\.com|redd\.it/.test(link)) lines.push("", `Link: ${link}`);

  const comments: string[] = [];
  const children = obj(obj(json[1])?.data)?.children;
  for (const c of Array.isArray(children) ? children : []) {
    const d = obj(obj(c)?.data);
    const text = str(d?.body);
    if (!text || d?.stickied === true) continue;
    comments.push(`- ${str(d?.author) ?? "someone"}: ${text.slice(0, 600)}`);
    if (comments.length >= MAX_COMMENTS) break;
  }
  if (comments.length) lines.push("", "Top comments:", ...comments);

  return {
    caption: lines.join("\n").slice(0, 12_000),
    ...(str(post.author) ? { author: `u/${str(post.author)}` } : {}),
    images: [],
    videos: [],
  };
}
