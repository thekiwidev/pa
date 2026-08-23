// A thin Gmail REST client. No "use node", no SDK.
//
// This is the §0.2 compute argument applied: the googleapis package needs the
// Node runtime at 512 MB against a 20 GB-hour monthly budget — roughly 39
// hours of action time versus 312 in V8 — to call a handful of endpoints with
// a bearer token and JSON bodies.

import { markdownToEmailHtml } from "../../lib/email/markdownToEmailHtml";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`gmail ${status}: ${body.slice(0, 300)}`);
    this.name = "GmailApiError";
  }
  /** 401 means the access token is stale or the grant is gone. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId?: string }> {
  return await gmailFetch(accessToken, "/profile");
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/**
 * `includeSpamTrash: true` is THE FEATURE, not a detail.
 *
 * users.messages.list excludes SPAM and TRASH by default, so the obvious
 * implementation silently misses every buried interview email — the exact
 * failure this project exists to prevent. Do not add labelIds: ["INBOX"].
 */
export async function listMessages(
  accessToken: string,
  options: { query: string; maxResults: number; pageToken?: string },
): Promise<{ messages?: GmailMessageRef[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    includeSpamTrash: "true",
    q: options.query,
    maxResults: String(options.maxResults),
  });
  if (options.pageToken) params.set("pageToken", options.pageToken);

  return await gmailFetch(accessToken, `/messages?${params.toString()}`);
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** `format=full` gives headers plus body parts without the raw MIME blob. */
export async function getMessage(
  accessToken: string,
  id: string,
): Promise<GmailMessage> {
  return await gmailFetch(accessToken, `/messages/${id}?format=full`);
}

export interface OutgoingReply {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  referencesHeader?: string;
  /** Gmail rejects a raw message whose headers don't match this thread —
   *  the correctness check for "did this actually land as a reply" is
   *  Gmail's own, and gmail.sendReply (Step 10) asserts the response agrees. */
  threadId: string;
}

/** RFC 2047 for a non-ASCII subject; an ASCII one is left untouched. */
function encodeSubject(subject: string): string {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
}

/**
 * Same chunked-base64 technique as convex/channels/telegram.ts's toBase64 —
 * String.fromCharCode(...bytes) blows the argument limit north of ~100 KB,
 * which an email with any real body reaches. base64url per Gmail's `raw`
 * field: `+`/`/` swapped for `-`/`_`, no padding.
 */
function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A boundary no body can contain. Random rather than fixed: a fixed boundary
 * appearing inside a quoted email would split the message at the wrong place.
 */
function mimeBoundary(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `----pa-${rand}`;
}

/**
 * multipart/alternative: the plain body as written, plus an HTML rendering.
 *
 * Was single-part text/plain until 2026-08-23, so a reply containing
 * "**bold**" reached the recipient with the asterisks visible. Order is
 * load-bearing — RFC 2046 says the LAST part is the preferred one, so
 * text/plain must come first.
 */
function buildRawMessage(msg: OutgoingReply): string {
  const boundary = mimeBoundary();
  const html = markdownToEmailHtml(msg.bodyText);

  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
    msg.cc.length ? `Cc: ${msg.cc.join(", ")}` : undefined,
    `Subject: ${encodeSubject(msg.subject)}`,
    msg.inReplyTo ? `In-Reply-To: ${msg.inReplyTo}` : undefined,
    msg.referencesHeader ? `References: ${msg.referencesHeader}` : undefined,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\r\n");

  const body = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    msg.bodyText,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    html,
    ``,
    `--${boundary}--`,
  ].join("\r\n");

  return base64UrlEncode(`${headers}\r\n\r\n${body}`);
}

export async function sendMessage(
  accessToken: string,
  msg: OutgoingReply,
): Promise<{ id: string; threadId: string }> {
  const res = await fetch(`${BASE}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildRawMessage(msg), threadId: msg.threadId }),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as { id: string; threadId: string };
}
