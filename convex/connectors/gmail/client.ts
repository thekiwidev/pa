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


// ─────────────────────────────────────────────────────────────────────────
// Phase 8 — modify, watch, and history.
//
// Everything below needs the gmail.modify scope. Note what is NOT here:
// there is no messages.delete and no threads.delete, because this project
// never requests https://mail.google.com/ and a permanent delete has no undo.
// TRASH is reachable through modify and is reversible; that is the line.
// ─────────────────────────────────────────────────────────────────────────

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export async function listLabels(accessToken: string): Promise<GmailLabel[]> {
  const res = await fetch(`${BASE}/labels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  const data = (await res.json()) as { labels?: GmailLabel[] };
  return data.labels ?? [];
}

export async function createLabel(accessToken: string, name: string): Promise<GmailLabel> {
  const res = await fetch(`${BASE}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as GmailLabel;
}

/**
 * Add and/or remove labels on one message.
 *
 * This is the single primitive behind archive, mark-read and label:
 *   archive     = remove INBOX
 *   mark read   = remove UNREAD
 *   mark unread = add UNREAD
 *
 * Gmail models all three as label edits, which is also why all three are
 * reversible — nothing here destroys anything.
 */
export async function modifyMessage(
  accessToken: string,
  messageId: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ id: string; labelIds?: string[] }> {
  const res = await fetch(`${BASE}/messages/${encodeURIComponent(messageId)}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      addLabelIds: changes.addLabelIds ?? [],
      removeLabelIds: changes.removeLabelIds ?? [],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as { id: string; labelIds?: string[] };
}

/**
 * Ask Gmail to publish change notifications to a Pub/Sub topic.
 *
 * The returned expiration is at most SEVEN DAYS out, and Google recommends
 * renewing daily. A lapsed watch fails silently — no error, just no
 * notifications ever again — which is why renewal is a cron and not a
 * one-time setup step, and why the polling sync stays as a safety net.
 */
export async function watchMailbox(
  accessToken: string,
  topicName: string,
): Promise<{ historyId: string; expiration: string }> {
  const res = await fetch(`${BASE}/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    // No labelIds filter: SPAM must be watched too. Filtering to INBOX here
    // would reintroduce the exact failure includeSpamTrash exists to prevent.
    body: JSON.stringify({ topicName }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as { historyId: string; expiration: string };
}

export async function stopWatch(accessToken: string): Promise<void> {
  const res = await fetch(`${BASE}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  // 404 means there was no active watch, which is the desired end state.
  if (!res.ok && res.status !== 404) throw new GmailApiError(res.status, await res.text());
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessageRef }[];
}

/**
 * What changed since `startHistoryId`.
 *
 * Returns `expired: true` when Gmail no longer holds that far back — history
 * is kept for a limited window, and an account that was quiet for a week
 * comes back with a 404. That is not an error, it is an instruction to fall
 * back to a full window sync, and conflating the two would mean silently
 * missing mail.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ expired: boolean; records: GmailHistoryRecord[]; historyId?: string }> {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "200",
  });
  const res = await fetch(`${BASE}/history?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 404) return { expired: true, records: [] };
  if (!res.ok) throw new GmailApiError(res.status, await res.text());

  const data = (await res.json()) as {
    history?: GmailHistoryRecord[];
    historyId?: string;
  };
  return { expired: false, records: data.history ?? [], historyId: data.historyId };
}
