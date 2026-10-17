// PURE. No ctx, no fetch — the only runtime import is a type, which is erased.
//
// It lives under connectors/gmail/ rather than lib/ because Gmail wire-format
// knowledge belongs in exactly one directory (invariant I-6). It is unit
// tested like anything in lib/.
//
// There is NO LLM in this phase. Everything below is deterministic extraction.
import type { GmailMessage, GmailPart } from "./client";
import { extractLinks, type EmailLink } from "../../lib/email/links";

/**
 * Three Convex limits stack here: a document is capped at 1 MiB, storage at
 * 0.5 GB, and — the binding one — database bandwidth at 1 GB/month. A 32 KB
 * body cap is what keeps a mailbox sync inside the free tier.
 */
export const BODY_CAP_BYTES = 32 * 1024;
export const TRUNCATION_MARKER = "\n\n[… truncated, full body in file storage]";

export interface NormalizedEmail {
  providerMessageId: string;
  threadId: string;
  labelIds: string[];
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
  ccAddresses: string[];
  replyTo?: string;
  subject?: string;
  bodyText?: string;
  bodyTruncated: boolean;
  /** https links with their visible text, read from the HTML part. NOT
   *  persisted — like bodyTruncated, callers strip it before upsert. It
   *  exists for the alert, which is built in the same action. */
  links: EmailLink[];
  snippet?: string;
  hasAttachments: boolean;
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  authResults?: { spf: string; dkim: string; dmarc: string };
  receivedAt: number;
  rfcMessageId?: string;
  inReplyTo?: string;
  referencesHeader?: string;
}

/** Headers are case-insensitive per RFC 5322, and Gmail does not normalize them. */
export function header(part: GmailPart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/** `"Ada Lovelace" <ada@example.com>` → both halves. */
export function parseAddress(raw: string): { address: string; name?: string } {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = angled[1]?.replace(/^"|"$/g, "").trim();
    return { address: (angled[2] ?? "").trim().toLowerCase(), name: name || undefined };
  }
  return { address: raw.trim().toLowerCase() };
}

/** Splits on commas that are not inside quotes or angle brackets. */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let buffer = "";
  let inQuotes = false;
  let inAngle = false;

  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;

    if (ch === "," && !inQuotes && !inAngle) {
      if (buffer.trim()) out.push(parseAddress(buffer).address);
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim()) out.push(parseAddress(buffer).address);
  return out.filter(Boolean);
}

/** Gmail encodes part bodies as base64url. atob wants standard base64, and
 *  the result is bytes, not text — decode as UTF-8 or non-ASCII mail mojibakes. */
export function decodeBase64Url(data: string): string {
  const padded = data.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * SPF / DKIM / DMARC verdicts out of Authentication-Results.
 * Phase 4 needs these for spoof resistance — a "this is your bank" email that
 * fails DMARC must not be classified CRITICAL on its subject line alone.
 */
export function parseAuthResults(
  raw: string | undefined,
): { spf: string; dkim: string; dmarc: string } | undefined {
  if (!raw) return undefined;
  const verdict = (method: string) => {
    const found = new RegExp(`\\b${method}=([a-z]+)`, "i").exec(raw);
    return found?.[1]?.toLowerCase() ?? "none";
  };
  return { spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc") };
}

/**
 * Gmail's `snippet` field is plain text with two forms of noise: HTML entities
 * (`&#39;` for an apostrophe) and zero-width characters some senders pad
 * subjects with to defeat clipping/dedup. Both render as garbage in Telegram.
 */
export function cleanSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return snippet;
  return snippet
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "") // zero-width chars
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface WalkResult {
  plain: string[];
  html: string[];
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
}

function walk(part: GmailPart | undefined, into: WalkResult): void {
  if (!part) return;

  const isAttachment = Boolean(part.filename && part.filename.length > 0);
  if (isAttachment) {
    into.attachments.push({
      filename: part.filename ?? "unnamed",
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
    });
  } else if (part.body?.data) {
    if (part.mimeType === "text/plain") into.plain.push(decodeBase64Url(part.body.data));
    else if (part.mimeType === "text/html") into.html.push(decodeBase64Url(part.body.data));
  }

  for (const child of part.parts ?? []) walk(child, into);
}

export function normalizeMessage(message: GmailMessage): NormalizedEmail {
  const payload = message.payload;
  const collected: WalkResult = { plain: [], html: [], attachments: [] };
  walk(payload, collected);

  // text/plain wins. Falling back to stripped HTML is lossy, so only do it
  // when there is no plain alternative at all.
  const rawBody =
    collected.plain.join("\n").trim() ||
    (collected.html.length ? stripHtml(collected.html.join("\n")) : "");

  const encoded = new TextEncoder().encode(rawBody);
  const bodyTruncated = encoded.length > BODY_CAP_BYTES;
  const bodyText = bodyTruncated
    ? new TextDecoder().decode(encoded.slice(0, BODY_CAP_BYTES)) + TRUNCATION_MARKER
    : rawBody;

  const from = parseAddress(header(payload, "From") ?? "");

  // internalDate is ms-epoch as a string and is what Gmail sorts by. The Date
  // header is sender-controlled and can be wrong or absent.
  const receivedAt = Number(message.internalDate ?? 0) || Date.now();

  return {
    providerMessageId: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: parseAddressList(header(payload, "To")),
    ccAddresses: parseAddressList(header(payload, "Cc")),
    replyTo: header(payload, "Reply-To"),
    subject: header(payload, "Subject"),
    bodyText: bodyText || undefined,
    bodyTruncated,
    links: extractLinks(collected.html, collected.plain),
    snippet: cleanSnippet(message.snippet),
    hasAttachments: collected.attachments.length > 0,
    attachments: collected.attachments,
    listUnsubscribe: header(payload, "List-Unsubscribe"),
    listUnsubscribePost: header(payload, "List-Unsubscribe-Post"),
    authResults: parseAuthResults(header(payload, "Authentication-Results")),
    receivedAt,
    rfcMessageId: header(payload, "Message-ID"),
    inReplyTo: header(payload, "In-Reply-To"),
    referencesHeader: header(payload, "References"),
  };
}
