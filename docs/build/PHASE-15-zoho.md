# Phase 15 — Zoho Mail, a second `EmailProvider`

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** `docs/personal-ai-assistant-build-plan-v3-convex.md` → *Phase 15 — Zoho and Outlook*. That source phase bundles Outlook in with Zoho; **this document covers Zoho only**. Outlook is explicitly out of scope — no Microsoft credentials exist for this deployment, by choice, and nothing below adds Microsoft Graph, `MS_CLIENT_ID`, or an Outlook connector.
- **Prerequisite:** Phase 3 (Gmail connector, read-only sync) complete. Every file below mirrors an existing Gmail file one-for-one; if you haven't read `convex/connectors/gmail/oauth.ts`, `client.ts`, `normalize.ts`, and `convex/gmail.ts`, read those first — this doc assumes you can see the shape it's copying.

**Why this phase exists.** Not "more email" — proof. The build plan's whole bet on `convex/lib/email/provider.ts`'s `EmailProvider` interface only pays off if a *second* real provider can satisfy it without changing the interface to fit. Zoho is that second provider: different OAuth endpoints, different REST shape, no Gmail-style "me" alias, no labels — only folders. If the abstraction survives that, it was real. If it doesn't, better to find out now, on a phase nobody depends on, than later when a third provider needs the same seam.

**A scope-honesty note before you start.** The exit criterion below (see "Done when") talks about a *badged Telegram card* and a *reply that sends*. Neither exists yet in this codebase — badged cards are Phase 5, sending is Phase 6. This phase builds the Zoho-specific slice (OAuth, fetch, normalize, sync) that those later phases will consume; it does not itself produce a card or a send. Each step's **Verify** line tells you what you can actually check *today*. The full end-to-end criterion is there so you know what "done" means once 5 and 6 exist — treat it as pending, not failing.

---

## What you'll have at the end

A second, real, working `connectedAccounts` row with `provider: "zoho"`, syncing on demand from both the Inbox and Zoho's junk folder into the same `emailMessages` table Gmail writes to — through the same `internal.model.emailMessages.upsert` mutation, unmodified. A message sitting in Zoho's junk folder gets the exact same `"SPAM"` entry in `labelIds` that a Gmail `SPAM`-labelled message gets, proven by a unit test with the same acceptance shape as Gmail's. And `convex/gmail.ts` now formally satisfies `convex/lib/email/provider.ts`'s `EmailProvider` interface — extracted from Gmail's real shape, not invented — with zero change to Gmail's actual sync behavior.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 1 | `convex/lib/email/provider.ts` | new | The `EmailProvider` interface, extracted from Gmail's actual current shape |
| 2 | `convex/connectors/zoho/oauth.ts` | new | Zoho's OAuth 2.0 handshake — mirrors `gmail/oauth.ts` |
| 3 | `convex/connectors/zoho/client.ts` | new | Thin Zoho Mail REST client — mirrors `gmail/client.ts` |
| 4 | `convex/connectors/zoho/normalize.ts` | new | Pure Zoho → `NormalizedEmail` extraction — mirrors `gmail/normalize.ts` |
| 5 | `tests/unit/zoho-normalize.test.ts` | new | The junk-folder-produces-the-badge acceptance test |
| 6 | `convex/zoho.ts` | new | `completeConnect` / `syncAccount` / `syncAll` — mirrors `convex/gmail.ts` |
| 7 | `convex/http.ts` | edit | `/oauth/zoho/start`, `/oauth/zoho/callback` |
| 8 | `convex/gmail.ts` | edit | Provider filter in `syncAll`; formally implement `EmailProvider` |

Plus one operational step at the end (Step 9) — no file, just how you actually connect a Zoho mailbox today given what this phase does and doesn't touch.

---

## Step 1 — The `EmailProvider` interface

**File:** `convex/lib/email/provider.ts` **(create)**

**What this file is for.** The shared contract both providers satisfy. It is **extracted from the Gmail connector's actual shape**, per the build plan's explicit instruction — not designed in the abstract first. What Gmail does today (Phase 3) is: connect, list, fetch-and-normalize. Nothing else. Send is Phase 6, label/archive/modify is Phase 8 — **neither is built yet**, so this interface does not include them. Adding capabilities the code cannot deliver would make this file lie about the codebase; extend `Capability` and `EmailProvider` when those phases actually land, the same way this file was extracted from working code instead of invented up front.

```ts
// PURE type-only module: interfaces and a re-exported type. No ctx, no
// fetch, no Convex import — this is the shared CONTRACT, not an
// implementation.
//
// Extracted from the Gmail connector's ACTUAL shape (Phase 3), per the
// build plan's explicit instruction: do not design an abstraction before a
// second real implementation needs it. What Gmail does today is connect,
// list, fetch-and-normalize — nothing else. convex/connectors/gmail/
// {oauth,client,normalize}.ts and convex/gmail.ts are the ground truth this
// file is extracted from.
//
// Gmail is READ-ONLY today (Phase 3). Send (Phase 6) and label/archive/
// modify (Phase 8) are not built yet, so this interface does not include
// them — adding capabilities the code cannot yet deliver would make this
// file lie about the codebase. Extend `Capability` and `EmailProvider` when
// those phases land, the same way this file was extracted from Gmail
// instead of invented up front.

import type { NormalizedEmail } from "../../connectors/gmail/normalize";

export type { NormalizedEmail };

/**
 * What a provider can currently do. Core code branches on capability
 * membership — `provider.capabilities.has("read")` — never on
 * `provider.id === "gmail"`. Zoho joins this phase with the same single
 * capability Gmail has.
 */
export type Capability = "read"; // "send" (Phase 6), "modify" (Phase 8) join later

export interface ProviderTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scopes: string[];
}

export interface ProviderProfile {
  emailAddress: string;
}

export interface ListOptions {
  query: string;
  maxResults: number;
  pageToken?: string;
}

export interface MessageRef {
  id: string;
  threadId: string;
}

export interface ListResult {
  refs: MessageRef[];
  nextPageToken?: string;
}

/**
 * One real implementation as of this phase (Gmail, formally adapted in
 * Step 8) and one this phase adds (Zoho — not yet wired through this exact
 * interface; see the note at the end of Step 6). Both are read-only.
 */
export interface EmailProvider {
  readonly id: string; // "gmail" | "zoho"
  readonly capabilities: ReadonlySet<Capability>;

  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<ProviderTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<ProviderTokenResponse>;

  getProfile(accessToken: string): Promise<ProviderProfile>;
  listMessages(accessToken: string, options: ListOptions): Promise<ListResult>;
  /** Fetches AND normalizes in one call — callers never see the wire format. */
  getMessage(accessToken: string, id: string): Promise<NormalizedEmail>;
}
```

**Verify:** `bun run typecheck` passes. This is a type-only file — there's nothing to run yet, and nothing implements it until Step 8.

---

## Step 2 — Zoho OAuth

**File:** `convex/connectors/zoho/oauth.ts` **(create)**

**What this file is for.** Zoho's OAuth 2.0 authorization-code handshake, over plain `fetch` — mirrors `convex/connectors/gmail/oauth.ts` exactly: same `authorizeUrl` / `exchangeCode` / `refreshAccessToken` / `requireClient` / `TokenRevoked` shape, different endpoints and env vars.

**A gap the source plan left open, and how this fills it.** The source build plan describes Zoho only as *"standard OAuth 2.0 authorization-code flow with its own client ID/secret and refresh token"* — it gives no endpoint URLs. Everything below is **reasoned** from Zoho Mail API's publicly documented conventions (`accounts.zoho.com` for OAuth), not copied from a verified current spec. The file says so at the top, loudly, per this project's own rule about never trusting an unverified external API shape blindly.

```ts
// Zoho OAuth 2.0, over plain fetch — mirrors convex/connectors/gmail/oauth.ts
// exactly. No Zoho SDK — same §0.2 compute argument as Gmail: this calls two
// JSON endpoints, which does not justify a "use node" (512 MB) dependency.
//
// ── VERIFY BEFORE RUNNING ──────────────────────────────────────────────
// The source build plan describes Zoho only as "standard OAuth 2.0
// authorization-code flow with its own client ID/secret and refresh token"
// — it does not give endpoint URLs. Everything below is REASONED from
// publicly documented Zoho Mail API conventions (accounts.zoho.com for
// OAuth), not copied from a verified current spec. Before running this
// against a real Zoho account, confirm against
// https://www.zoho.com/mail/help/api/ :
//   1. The accounts domain. Zoho has REGIONAL DATA CENTERS — a Zoho account
//      created under the .eu, .in, .com.au, or .jp signup flow authenticates
//      against accounts.zoho.eu / .in / .com.au / .jp, NOT accounts.zoho.com.
//      Using the wrong domain fails the whole handshake, not just one call.
//   2. The exact scope strings below (ZohoMail.accounts.READ etc.) — Zoho's
//      scope naming has changed between API versions historically.
//   3. Whether `access_type=offline` alone is enough to get a refresh token
//      on first authorization, the way Gmail additionally needs
//      `prompt=consent`. This file does NOT send `prompt=consent` because
//      Zoho's docs do not document that parameter; if re-authorizing an
//      already-granted account silently returns no refresh token, that is
//      the first thing to check.
// ──────────────────────────────────────────────────────────────────────

const AUTH = "https://accounts.zoho.com/oauth/v2/auth";
const TOKEN = "https://accounts.zoho.com/oauth/v2/token";

/**
 * Read-only Zoho Mail scopes. INFERRED from Zoho Mail API's documented
 * scope naming convention (`ZohoMail.<resource>.<action>`) — verify the
 * exact strings before running. `accounts.READ` is what resolves the
 * mailbox's internal accountId (see connectors/zoho/client.ts's
 * getAccounts), which every other Zoho Mail call needs and Gmail has no
 * equivalent of.
 */
export const ZOHO_READONLY_SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.folders.READ",
  "ZohoMail.messages.READ",
] as const;

export class TokenRevoked extends Error {
  constructor(detail: string) {
    super(`refresh token rejected: ${detail.slice(0, 200)}`);
    this.name = "TokenRevoked";
  }
}

function requireClient(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = process.env.ZOHO_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REDIRECT_URI must all be set",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(state: string): string {
  const { clientId, redirectUri } = requireClient();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ZOHO_READONLY_SCOPES.join(","),
    state,
    // Mirrors Gmail's access_type=offline — needed to receive a refresh
    // token at all. See the verification note above.
    access_type: "offline",
  });
  return `${AUTH}?${params.toString()}`;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scopes: string[];
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = requireClient();
  return await postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireClient();
  return await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const text = await res.text();

  if (!res.ok) {
    // Zoho is described as "standard OAuth 2.0", so RFC 6749 §5.2's
    // `invalid_grant` is the reasoned guess for a dead/revoked refresh
    // token — the same signal Gmail's `invalid_grant` gives. UNVERIFIED:
    // confirm Zoho actually returns this exact string before trusting the
    // TokenRevoked branch over the generic Error branch below.
    if (text.includes("invalid_grant") || text.includes("invalid_code")) {
      throw new TokenRevoked(text);
    }
    throw new Error(`zoho token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };

  // Zoho's token endpoint has been reported to return 200 with an `error`
  // field in the body for some failure modes, rather than a non-2xx status.
  // UNVERIFIED for this exact endpoint — treat as belt-and-braces.
  if (json.error) throw new Error(`zoho token endpoint returned error: ${json.error}`);
  if (!json.access_token) throw new Error("zoho returned no access_token");

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in ?? 3600,
    scopes: json.scope ? json.scope.split(",") : [],
  };
}
```

**Verify:** `bun run typecheck` passes. `ZOHO_READONLY_SCOPES` gets exercised by the "scopes — least privilege" test in Step 5.

---

## Step 3 — The Zoho Mail client

**File:** `convex/connectors/zoho/client.ts` **(create)**

**What this file is for.** A thin Zoho Mail REST client, mirroring `convex/connectors/gmail/client.ts`'s style: no SDK, no `"use node"`, plain `fetch`. Same `GmailApiError`-equivalent (`ZohoApiError`), same `gmailFetch`-equivalent (`zohoFetch`).

**Two real differences from Gmail, not stylistic ones.** First, Zoho's documented auth header is `Zoho-oauthtoken <token>`, not `Bearer <token>` — copying Gmail's header here would fail every request with a 401 that looks exactly like a bad token. Second, Zoho has no Gmail-style `"me"` alias: every call after authorization needs the mailbox's internal `accountId`, resolved via a `getAccounts` call Gmail's `syncAccount` has no equivalent of.

```ts
// A thin Zoho Mail REST client. No SDK, no "use node" — plain fetch, same
// §0.2 compute argument as connectors/gmail/client.ts.
//
// ── VERIFY BEFORE RUNNING ──────────────────────────────────────────────
// Endpoint paths below are REASONED from Zoho Mail API's publicly
// documented conventions (mail.zoho.com/api base, /accounts,
// /accounts/{id}/folders, /accounts/{id}/messages/view), not copied from a
// verified current spec — the source build plan gives no endpoint detail
// for Zoho. Confirm against https://www.zoho.com/mail/help/api/ before
// running, in particular:
//   1. The API domain — REGIONAL DATA CENTERS again: mail.zoho.eu / .in /
//      .com.au / .jp for accounts signed up outside the .com data center.
//      Must match whichever accounts.zoho.* domain issued the token.
//   2. The exact message-fetch path (getMessage below) — Zoho's API has
//      separate "summary" and "content" endpoints for a message in some
//      API generations, and this file assumes one call returns everything
//      a sync needs. If it returns a truncated body, split this into two
//      calls.
// ──────────────────────────────────────────────────────────────────────

const BASE = "https://mail.zoho.com/api";

export class ZohoApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`zoho ${status}: ${body.slice(0, 300)}`);
    this.name = "ZohoApiError";
  }
  /** 401 means the access token is stale; Zoho documents 403 for scope
   *  problems, which needs a reconnect just the same as Gmail's 403. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

async function zohoFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    // Zoho's documented auth header format is "Zoho-oauthtoken <token>",
    // NOT "Bearer <token>" — the one Zoho-specific wire detail worth
    // flagging in bold, since copying Gmail's Bearer header here would fail
    // every request with a 401 that looks like a bad token, not a bad
    // header.
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) throw new ZohoApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export interface ZohoAccount {
  accountId: string;
  primaryEmailAddress: string;
}

/**
 * Zoho has no Gmail-style "me" alias — every other call needs the
 * mailbox's internal accountId, resolved here first. This is the extra
 * round trip Gmail's syncAccount does not need.
 */
export async function getAccounts(accessToken: string): Promise<ZohoAccount[]> {
  const json = await zohoFetch<{ data: ZohoAccount[] }>(accessToken, "/accounts");
  return json.data ?? [];
}

export interface ZohoFolder {
  folderId: string;
  folderName: string;
  path: string;
}

export async function listFolders(
  accessToken: string,
  accountId: string,
): Promise<ZohoFolder[]> {
  const json = await zohoFetch<{ data: ZohoFolder[] }>(
    accessToken,
    `/accounts/${accountId}/folders`,
  );
  return json.data ?? [];
}

/**
 * Zoho's own junk-folder concept has no fixed folderId — it is whichever
 * folder Zoho created for this mailbox, identified here by name. UNVERIFIED:
 * confirm the folder Zoho actually uses is named "Spam" (English UI) — a
 * mailbox provisioned under a different locale may use a translated name,
 * which this heuristic will miss silently. If that turns out to matter,
 * check whether the real /folders response carries a machine-readable type
 * field to key off instead of the display name.
 */
export function isJunkFolder(folder: ZohoFolder): boolean {
  const name = folder.folderName.toLowerCase();
  return name === "spam" || name === "junk";
}

export function isInboxFolder(folder: ZohoFolder): boolean {
  return folder.folderName.toLowerCase() === "inbox";
}

export interface ZohoMessageRef {
  messageId: string;
  folderId: string;
}

export async function listMessages(
  accessToken: string,
  accountId: string,
  folderId: string,
  options: { limit: number },
): Promise<ZohoMessageRef[]> {
  const params = new URLSearchParams({
    folderId,
    limit: String(options.limit),
  });
  const json = await zohoFetch<{ data: { messageId: string }[] }>(
    accessToken,
    `/accounts/${accountId}/messages/view?${params.toString()}`,
  );
  return (json.data ?? []).map((m) => ({ messageId: m.messageId, folderId }));
}

/**
 * Raw Zoho message shape, narrowed to the fields normalize.ts needs. Field
 * names are REASONED from Zoho Mail API documentation conventions — verify
 * against a real response before trusting this shape. `threadId` is left
 * optional and UNVERIFIED: Zoho's conversation-grouping field, if one is
 * exposed here at all, may be named differently (`conversationId` is a
 * plausible alternative). See normalize.ts's fallback for what happens if
 * it's genuinely absent.
 */
export interface ZohoMessage {
  messageId: string;
  folderId: string;
  threadId?: string;
  subject?: string;
  summary?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  receivedTime?: string; // ms-epoch, as a string
  hasAttachment?: string; // "true" | "false"
  content?: string; // HTML body
  messageIdHeader?: string; // RFC Message-ID, if exposed
}

export async function getMessage(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<ZohoMessage> {
  const json = await zohoFetch<{ data: ZohoMessage }>(
    accessToken,
    `/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
  );
  return { ...json.data, messageId, folderId };
}
```

**Verify:** `bun run typecheck` passes. This file has no unit tests of its own — like `connectors/gmail/client.ts`, everything here does real network I/O, so it's exercised for real in Step 9's operational connect, not in `bun test`.

---

## Step 4 — Zoho normalization

**File:** `convex/connectors/zoho/normalize.ts` **(create)**

**What this file is for.** Pure, deterministic extraction from Zoho's raw shape into the same `NormalizedEmail` type Gmail produces — mirrors `convex/connectors/gmail/normalize.ts`'s style exactly. No `ctx`, no `fetch`, unit-tested like anything in `lib/`, living under `connectors/zoho/` (not `lib/`) because wire-format knowledge belongs in exactly one directory per provider, same as Gmail's.

**The one piece of real logic this file adds.** Gmail conveys "this is spam" with a `SPAM` entry in `labelIds`. Zoho has no labels, only folders. This file **synthesizes** that same `"SPAM"` string into `labelIds` when the caller says the message came from Zoho's junk folder — so every downstream consumer that already checks `labelIds.includes("SPAM")` (Phase 4's classifier, Phase 5's card badge) works **unmodified** for a second provider. That's the acceptance bar this whole phase exists to prove, not a metaphor — which is why Step 5's test asserts on it directly.

```ts
// PURE. No ctx, no fetch — mirrors convex/connectors/gmail/normalize.ts's
// style exactly: deterministic extraction, unit-tested like anything in
// lib/. Lives under connectors/zoho/ rather than lib/ for the same reason
// Gmail's does — wire-format knowledge belongs in exactly one directory per
// provider (invariant I-6). Kept self-contained rather than importing
// gmail/normalize.ts's helpers, for the same reason.
//
// There is no LLM here. The one new piece of logic this file adds beyond
// Gmail's is the junk-folder mapping: Gmail conveys "this is spam" via a
// SPAM entry in labelIds; Zoho has no labels, only folders. This file
// SYNTHESIZES the same "SPAM" string into labelIds when the caller says the
// message came from Zoho's junk folder — so every downstream consumer that
// already checks `labelIds.includes("SPAM")` (the classifier in Phase 4,
// the card badge in Phase 5) works unmodified for a second provider. That
// is the acceptance bar this phase is proving, not a metaphor.
import type { NormalizedEmail } from "../gmail/normalize";
import type { ZohoMessage } from "./client";

export type { NormalizedEmail };

export const BODY_CAP_BYTES = 32 * 1024;
export const TRUNCATION_MARKER = "\n\n[… truncated, full body in file storage]";

/** `"Ada Lovelace" <ada@example.com>` → both halves. Same technique as
 *  gmail/normalize.ts's parseAddress, kept as a separate copy per I-6
 *  rather than a cross-connector import. */
export function parseAddress(raw: string): { address: string; name?: string } {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = angled[1]?.replace(/^"|"$/g, "").trim();
    return { address: (angled[2] ?? "").trim().toLowerCase(), name: name || undefined };
  }
  return { address: raw.trim().toLowerCase() };
}

/** Zoho's toAddress/ccAddress fields are comma-separated strings, same
 *  shape as an RFC 5322 address list, without Gmail's need to dodge commas
 *  inside quoted display names as often in practice — kept simple. */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseAddress(part).address);
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

export function normalizeZohoMessage(
  message: ZohoMessage,
  source: { isJunk: boolean },
): NormalizedEmail {
  const from = parseAddress(message.fromAddress ?? "");
  const rawBody = stripHtml(message.content ?? "");

  const encoded = new TextEncoder().encode(rawBody);
  const bodyTruncated = encoded.length > BODY_CAP_BYTES;
  const bodyText = bodyTruncated
    ? new TextDecoder().decode(encoded.slice(0, BODY_CAP_BYTES)) + TRUNCATION_MARKER
    : rawBody;

  const receivedAt = Number(message.receivedTime ?? 0) || Date.now();

  // The one Zoho-specific piece of logic in this file: synthesize the same
  // "SPAM" sentinel Gmail's own labelIds carries, plus a raw marker of
  // which real Zoho folder it came from — never fed to a prompt, this is
  // for a human reading the database.
  const labelIds = source.isJunk
    ? ["SPAM", `ZOHO_FOLDER:${message.folderId}`]
    : [`ZOHO_FOLDER:${message.folderId}`];

  return {
    providerMessageId: message.messageId,
    // UNVERIFIED: falls back to the message's own id when Zoho exposes no
    // thread/conversation field on this endpoint (see client.ts's
    // ZohoMessage.threadId comment). Until confirmed, Zoho messages will
    // not visually thread together the way Gmail's do.
    threadId: message.threadId ?? message.messageId,
    labelIds,
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: parseAddressList(message.toAddress),
    ccAddresses: parseAddressList(message.ccAddress),
    replyTo: undefined,
    subject: message.subject,
    bodyText: bodyText || undefined,
    bodyTruncated,
    snippet: message.summary,
    hasAttachments: message.hasAttachment === "true",
    // Not built: per-attachment filename/mimeType/size extraction, the way
    // Gmail's walk() produces. Zoho's message-view response only confirms
    // attachments EXIST (hasAttachment); listing them needs a further
    // endpoint this phase does not model. hasAttachments is still correct
    // and is what Phase 6's "does this draft need an attachment prompt"
    // check would use first.
    attachments: [],
    listUnsubscribe: undefined,
    listUnsubscribePost: undefined,
    authResults: undefined,
    receivedAt,
    rfcMessageId: message.messageIdHeader,
    inReplyTo: undefined,
    referencesHeader: undefined,
  };
}
```

**Verify:** none yet — Step 5, immediately next, is this file's test suite.

---

## Step 5 — The acceptance test

**File:** `tests/unit/zoho-normalize.test.ts` **(create)**

**What this file is for.** The same "message in junk produces the badge" acceptance shape as Gmail's normalizer tests (`tests/unit/gmail-normalize.test.ts`'s *"keeps SPAM in labelIds — the whole point of the phase"*), applied to Zoho — proving the abstraction survives a second provider, not just describing it.

```ts
import { describe, expect, test } from "bun:test";
import {
  normalizeZohoMessage,
  parseAddress,
  parseAddressList,
  stripHtml,
  BODY_CAP_BYTES,
} from "../../convex/connectors/zoho/normalize";
import type { ZohoMessage } from "../../convex/connectors/zoho/client";
import { ZOHO_READONLY_SCOPES } from "../../convex/connectors/zoho/oauth";

const base: ZohoMessage = {
  messageId: "z1",
  folderId: "f_inbox",
  subject: "Interview invitation",
  summary: "a snippet",
  fromAddress: '"Recruiter" <jobs@corp.example>',
  toAddress: "me@example.com",
  ccAddress: "hr@corp.example, boss@corp.example",
  receivedTime: "1755648000000",
  hasAttachment: "false",
  content: "<p>Can you interview Tuesday?</p>",
};

describe("normalizeZohoMessage — the junk-folder acceptance bar", () => {
  test("a message from the Inbox folder carries no SPAM label", () => {
    const n = normalizeZohoMessage(base, { isJunk: false });
    expect(n.labelIds).not.toContain("SPAM");
  });

  test("a message from Zoho's junk folder produces the same SPAM entry Gmail's SPAM label maps to — the whole point of the phase", () => {
    const n = normalizeZohoMessage(base, { isJunk: true });
    expect(n.labelIds).toContain("SPAM");
  });

  test("keeps a raw marker of which real Zoho folder it came from", () => {
    const n = normalizeZohoMessage(base, { isJunk: true });
    expect(n.labelIds.some((l) => l.startsWith("ZOHO_FOLDER:"))).toBe(true);
  });
});

describe("normalizeZohoMessage — extraction", () => {
  test("extracts headers, addresses and body deterministically", () => {
    const n = normalizeZohoMessage(base, { isJunk: false });
    expect(n.fromAddress).toBe("jobs@corp.example");
    expect(n.fromName).toBe("Recruiter");
    expect(n.ccAddresses).toEqual(["hr@corp.example", "boss@corp.example"]);
    expect(n.subject).toBe("Interview invitation");
    expect(n.bodyText).toBe("Can you interview Tuesday?");
    expect(n.receivedAt).toBe(1755648000000);
  });

  test("caps the body and flags the truncation, same as Gmail's normalizer", () => {
    const n = normalizeZohoMessage(
      { ...base, content: "x".repeat(50_000) },
      { isJunk: false },
    );
    expect(n.bodyTruncated).toBe(true);
    expect(n.bodyText!.length).toBeLessThan(BODY_CAP_BYTES + 200);
    expect(n.bodyText).toContain("truncated");
  });

  test("falls back to the message's own id as threadId when Zoho exposes no thread field — UNVERIFIED, see normalize.ts", () => {
    const n = normalizeZohoMessage(base, { isJunk: false });
    expect(n.threadId).toBe("z1");
  });

  test("prefers an explicit threadId when the raw message carries one", () => {
    const n = normalizeZohoMessage({ ...base, threadId: "conv-42" }, { isJunk: false });
    expect(n.threadId).toBe("conv-42");
  });
});

describe("parseAddress / parseAddressList", () => {
  test("splits a display name from an address", () => {
    expect(parseAddress('"Ada Lovelace" <ada@example.com>')).toEqual({
      address: "ada@example.com",
      name: "Ada Lovelace",
    });
  });
  test("empty for a missing header", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("stripHtml", () => {
  test("drops script and style content entirely", () => {
    expect(stripHtml("<style>a{}</style><p>Hi</p><script>x()</script>")).toBe("Hi");
  });
});

describe("scopes — least privilege", () => {
  test("requests only read scopes, same discipline as Gmail's Phase 3 scopes", () => {
    for (const scope of ZOHO_READONLY_SCOPES) {
      expect(scope).toContain("READ");
      expect(scope).not.toContain("WRITE");
      expect(scope).not.toContain("CREATE");
      expect(scope).not.toContain("UPDATE");
      expect(scope).not.toContain("DELETE");
      expect(scope).not.toContain("ALL");
    }
  });
});
```

**Verify:** `bun test` — all new Zoho tests pass, and the existing `gmail-normalize.test.ts` suite still passes unchanged (the abstraction didn't touch it).

---

## Step 6 — Connect and sync

**File:** `convex/zoho.ts` **(create)**

**What this file is for.** Mirrors `convex/gmail.ts`'s `completeConnect` / `syncAccount` / `syncAll` shape, adapted for two real Zoho differences: no `/profile`-equivalent endpoint (the mailbox address comes from `getAccounts` instead), and no single query that covers every folder the way Gmail's `includeSpamTrash: true` does — this phase syncs the Inbox and the junk folder explicitly, by name.

**A schema gap this phase deliberately doesn't close.** Zoho's internal `accountId` (needed for every API call after authorization) isn't persisted anywhere on the `connectedAccounts` row — doing so would need a `schema.ts` edit, which is outside this phase's file manifest. So `syncAccount` below re-resolves it via `getAccounts` on every sync: one extra `GET` per run, the honest cost of not touching the schema here rather than a silent inefficiency.

```ts
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { seal, open } from "./security/crypto";
import {
  exchangeCode,
  refreshAccessToken,
  ZOHO_READONLY_SCOPES,
  TokenRevoked,
} from "./connectors/zoho/oauth";
import {
  getAccounts,
  listFolders,
  listMessages,
  getMessage,
  isJunkFolder,
  isInboxFolder,
  ZohoApiError,
} from "./connectors/zoho/client";
import { normalizeZohoMessage } from "./connectors/zoho/normalize";
import { sendMessage } from "./channels/telegram";

/** How many messages per folder per sync. Zoho has no single query that
 *  covers every folder the way Gmail's includeSpamTrash does, so this phase
 *  syncs the Inbox and the junk folder explicitly, each capped separately. */
const MAX_PER_FOLDER = 25;

/**
 * Finish the OAuth handshake. Mirrors convex/gmail.ts's completeConnect
 * exactly, adapted for Zoho's shape: no /profile-equivalent endpoint, so
 * the mailbox address comes from getAccounts() instead.
 */
export const completeConnect = internalAction({
  args: {
    code: v.string(),
    userId: v.id("users"),
    label: v.string(),
    telegramId: v.string(),
  },
  handler: async (ctx, args) => {
    const tokens = await exchangeCode(args.code);

    if (!tokens.refreshToken) {
      throw new Error(
        "Zoho returned no refresh token. Remove this app under your Zoho " +
          "Account security settings (Manage Third-Party Applications) and " +
          "connect again.",
      );
    }

    // Which mailbox did the user actually pick? Never assume — same
    // discipline as gmail.ts's completeConnect. Zoho has no "me" alias, so
    // this is a real API call, not metadata already in hand.
    const accounts = await getAccounts(tokens.accessToken);
    const account = accounts[0];
    if (!account) throw new Error("Zoho returned no mail accounts for this token");

    const sealed = await seal(tokens.refreshToken);

    const result = await ctx.runMutation(internal.model.connectedAccounts.upsert, {
      userId: args.userId,
      provider: "zoho",
      accountEmail: account.primaryEmailAddress,
      displayName: account.primaryEmailAddress,
      label: args.label,
      encryptedCredentials: sealed.ciphertext,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      scopesGranted: tokens.scopes.length ? tokens.scopes : [...ZOHO_READONLY_SCOPES],
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "user",
      action: "account.connect",
      targetType: "connectedAccounts",
      targetId: result.accountId,
      args: { provider: "zoho", label: args.label, email: account.primaryEmailAddress },
      result: "ok",
    });

    await sendMessage(
      args.telegramId,
      `✅ Connected ${account.primaryEmailAddress} as "${args.label}".\n` +
        `Read-only. Syncing now — including the junk folder.`,
    );

    await ctx.runAction(internal.zoho.syncAccount, { accountId: result.accountId });
    return { accountEmail: account.primaryEmailAddress };
  },
});

/**
 * Decrypt the refresh token and mint an access token. Identical contract to
 * gmail.ts's accessTokenFor: the plaintext lives only inside this
 * function's frame, is never written to the database, never logged, and
 * never enters a prompt.
 */
async function accessTokenFor(
  ctx: ActionCtx,
  accountId: Id<"connectedAccounts">,
): Promise<string> {
  const account = await ctx.runQuery(internal.model.connectedAccounts.get, { accountId });
  if (!account) throw new Error("account not found");

  const refreshToken = await open({
    ciphertext: account.encryptedCredentials,
    iv: account.credentialIv,
    authTag: account.credentialAuthTag,
  });

  const tokens = await refreshAccessToken(refreshToken);
  return tokens.accessToken;
}

export const syncAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status === "REVOKED") return;

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, args.accountId);
    } catch (error) {
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(ctx, account.userId, args.accountId, account.accountEmail);
        return;
      }
      throw error;
    }

    let stored = 0;
    let fresh = 0;

    try {
      // Not built: the resolved Zoho accountId is not persisted on the
      // connectedAccounts row (that would need a schema.ts edit, out of
      // scope for this phase's file manifest), so every sync re-resolves
      // it. One extra GET per sync — cheap, and the honest alternative to
      // a schema change this doc was not asked to make.
      const zohoAccounts = await getAccounts(accessToken);
      const zohoAccountId = zohoAccounts[0]?.accountId;
      if (!zohoAccountId) throw new Error("Zoho returned no mail accounts for this token");

      const folders = await listFolders(accessToken, zohoAccountId);
      const targets = folders.filter((f) => isInboxFolder(f) || isJunkFolder(f));

      for (const folder of targets) {
        const refs = await listMessages(accessToken, zohoAccountId, folder.folderId, {
          limit: MAX_PER_FOLDER,
        });

        for (const ref of refs) {
          const raw = await getMessage(accessToken, zohoAccountId, ref.folderId, ref.messageId);
          const normalized = normalizeZohoMessage(raw, { isJunk: isJunkFolder(folder) });

          const { bodyTruncated: _bodyTruncated, ...row } = normalized;
          const result = await ctx.runMutation(internal.model.emailMessages.upsert, {
            accountId: args.accountId,
            ...row,
          });
          stored++;
          if (result.created) fresh++;
        }
      }

      await ctx.runMutation(internal.model.connectedAccounts.markSynced, {
        accountId: args.accountId,
      });

      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "zoho.sync",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: { seen: stored, new: fresh, folders: targets.map((f) => f.folderName) },
        result: "ok",
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof ZohoApiError && error.isAuthFailure) {
        await notifyNeedsReauth(ctx, account.userId, args.accountId, account.accountEmail);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "zoho.sync",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: { seen: stored },
        result: "error",
        errorMessage: detail.slice(0, 500),
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
});

/**
 * The cron target for Zoho accounts only (this phase does not add a cron —
 * see "Next"). Filters in code: connectedAccounts has no
 * by_status_provider index, and this list is small (Convex caps a single
 * query at 32,000 scanned documents; a personal assistant's account count
 * will never approach that), so a bounded scan plus a filter is the same
 * style already used elsewhere in this codebase, not a new index.
 */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    for (const account of accounts.filter((a) => a.provider === "zoho")) {
      try {
        await ctx.runAction(internal.zoho.syncAccount, { accountId: account._id });
      } catch (error) {
        console.warn(
          `zoho_sync_failed account=${account._id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
});

async function notifyNeedsReauth(
  ctx: ActionCtx,
  userId: Id<"users">,
  accountId: Id<"connectedAccounts">,
  accountEmail: string,
) {
  await ctx.runMutation(internal.model.connectedAccounts.markNeedsReauth, {
    accountId,
    reason: "refresh token rejected",
  });

  const user = await ctx.runQuery(internal.model.users.get, { userId });
  if (!user) return;

  await sendMessage(
    user.telegramId,
    `⚠️ ${accountEmail} needs re-authorizing — Zoho rejected the saved token.\n\n` +
      `Send: /reconnect ${accountEmail}`,
  );
}
```

**A scoping note, stated plainly rather than left implicit.** `convex/zoho.ts` does **not** export a `zohoProvider: EmailProvider` object the way Step 8 makes Gmail do. Zoho's real sync loop carries folder-resolution logic (`getAccounts` → `listFolders` → filter → per-folder `listMessages`/`getMessage`) that doesn't fit `EmailProvider`'s flat `listMessages`/`getMessage` shape without either leaking folder concepts into the interface or hiding real behavior behind it. Formally routing Zoho through the interface — the way Gmail now does — is natural follow-up work once a shared sync loop exists to justify it (Phase 8's push/reconciliation work already has to touch this loop for webhooks). This phase proves the interface's *type* is real, by having a working provider (Gmail) satisfy it structurally and by having Zoho's `normalize.ts` independently produce the exact same `NormalizedEmail` shape — not by forcing Zoho through methods it doesn't cleanly fit yet.

**Verify:** `bun run typecheck` passes. `bunx convex dev` pushes without error (new file, no schema change). The real exercise is Step 9's operational connect, below.

---

## Step 7 — Wire the OAuth routes

**File:** `convex/http.ts` **(edit)**

**What this does.** Adds `/oauth/zoho/start` and `/oauth/zoho/callback`, mirroring `/oauth/google/start` and `/oauth/google/callback` exactly — same nonce-is-the-authorization model, same `oauthStates` table (already provider-agnostic: `oauthStates.provider` is a plain `v.string()` in `convex/schema.ts`, no schema edit needed), same "acknowledge fast, do the token exchange in the background" pattern.

First, add the Zoho import alongside the existing Gmail one (the two `authorizeUrl` names collide, so alias the new one):

```ts
import { authorizeUrl } from "./connectors/gmail/oauth";
import { authorizeUrl as zohoAuthorizeUrl } from "./connectors/zoho/oauth";
```

Then add these two routes, right after the existing `/oauth/google/callback` block and before the `// Phase 8 adds: POST /webhooks/gmail` comment:

```ts
/**
 * Zoho's version of /oauth/google/start. Same nonce discipline: this route
 * is public (every .convex.site route is), so a live, unexpired,
 * single-use nonce IS the authorization — minted by /connect (or, until
 * that command learns about Zoho, by hand — see this doc's Step 9).
 */
http.route({
  path: "/oauth/zoho/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const nonce = new URL(request.url).searchParams.get("state");
    if (!nonce) return page(400, "Missing state", "That link is malformed.");

    const state = await ctx.runMutation(internal.model.oauthStates.peek, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Mint a new one.",
      );
    }

    return new Response(null, {
      status: 302,
      headers: { Location: zohoAuthorizeUrl(nonce) },
    });
  }),
});

/**
 * Zoho's version of /oauth/google/callback. The state row is consumed
 * atomically, same as Google's — a replayed callback finds nothing. The
 * code exchange happens in an action because it fetches, and because the
 * refresh token must be encrypted before any mutation sees it.
 */
http.route({
  path: "/oauth/zoho/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;

    const denied = params.get("error");
    if (denied) return page(200, "Not connected", `Zoho said: ${denied}. Nothing was saved.`);

    const code = params.get("code");
    const nonce = params.get("state");
    if (!code || !nonce) return page(400, "Missing parameters", "That callback was incomplete.");

    const state = await ctx.runMutation(internal.model.oauthStates.consume, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Mint a new one.",
      );
    }

    const user = await ctx.runQuery(internal.model.users.get, { userId: state.userId });
    if (!user) return page(500, "Unknown user", "Could not identify who started this.");

    await ctx.scheduler.runAfter(0, internal.zoho.completeConnect, {
      code,
      userId: state.userId,
      label: state.label,
      telegramId: user.telegramId,
    });

    return page(
      200,
      "Connected",
      "You can close this tab — the confirmation is in Telegram.",
    );
  }),
});
```

**A latent inconsistency worth naming, not silently fixing.** `convex/model/oauthStates.ts`'s `issue` mutation hardcodes `provider: "google"` on every row it inserts — and neither `peek` nor `consume` ever reads that field back. In practice this means the `provider` column is currently decorative: which OAuth flow actually runs is decided entirely by which URL path the nonce is redeemed against (`/oauth/google/start` vs. `/oauth/zoho/start`), not by anything stored on the row. That's *why* reusing the table needs no schema change — but it also means a nonce minted for "google" works just as well against the Zoho route today. Worth tightening (`issue` taking a real `provider` argument, the callback checking it matches) once `convex/assistant.ts`'s `/connect` command is taught about more than one provider — not done here, since `assistant.ts` and `model/oauthStates.ts` are both outside this phase's file manifest.

**Verify:** `bunx convex dev` pushes without error. `curl -s https://<dev>.convex.site/oauth/zoho/start` (no `state` param) returns 400 — confirms the route is registered before you use it for real in Step 9.

---

## Step 8 — Gmail formally implements `EmailProvider`

**File:** `convex/gmail.ts` **(edit)**

**What this does, and why it's two unrelated-looking changes in one step.** First, a **correctness fix this phase requires**: `syncAll` currently loops over *every* `ACTIVE` row in `connectedAccounts` and hands each one to Gmail's own `syncAccount` — harmless when Gmail was the only provider, actively wrong now that a Zoho row can sit in the same table. Without a filter, `gmail.syncAll` would try to mint a Google access token out of a Zoho refresh token for every Zoho account. Second, the "extract, don't redesign" step the plan calls for: `gmailProvider`, a value that formally satisfies Step 1's `EmailProvider`, assembled from the connector's existing functions — **`syncAccount`, `syncAll`, and `completeConnect` above are not touched**, so Gmail's actual behavior is genuinely unchanged.

Add `authorizeUrl` to the existing import from `./connectors/gmail/oauth` (it wasn't needed in `gmail.ts` before this step) and import the interface type:

```ts
import {
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  GMAIL_READONLY_SCOPES,
  TokenRevoked,
} from "./connectors/gmail/oauth";
import { getProfile, listMessages, getMessage, GmailApiError } from "./connectors/gmail/client";
import { normalizeMessage } from "./connectors/gmail/normalize";
import type { EmailProvider } from "./lib/email/provider";
```

Edit `syncAll`'s loop to filter by provider:

```ts
/** The cron target. One account failing must not stop the others. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    // A second provider (Zoho, Phase 15) now shares this table and this
    // status index. Without this filter, gmail.syncAll would try to mint a
    // Google access token from a Zoho refresh token for every Zoho account
    // — filtering here is a correctness fix this phase REQUIRES, not
    // optional cleanup. Existing Gmail-only deployments see no behavior
    // change: every currently-ACTIVE account was already "gmail".
    for (const account of accounts.filter((a) => a.provider === "gmail")) {
      try {
        await ctx.runAction(internal.gmail.syncAccount, { accountId: account._id });
      } catch (error) {
        console.warn(
          `gmail_sync_failed account=${account._id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
});
```

Then append this at the bottom of the file:

```ts
/**
 * Gmail formally satisfies EmailProvider — assembled from the connector's
 * existing functions. Nothing above (completeConnect / syncAccount /
 * syncAll) changes: this is the "extract, don't redesign" step. The
 * interface in convex/lib/email/provider.ts was written FROM this shape,
 * so satisfying it is wrapping, not rewriting.
 *
 * Not yet wired INTO syncAccount/syncAll above — those still call the free
 * functions directly, unchanged, per "behavior unchanged." A shared sync
 * loop that dispatches through `gmailProvider` (and, eventually, a fully
 * interface-conformant Zoho provider) is Phase 8-shaped work — that phase
 * already has to touch this sync loop to add push webhooks — not this
 * phase's job.
 */
export const gmailProvider: EmailProvider = {
  id: "gmail",
  capabilities: new Set(["read"]),
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getProfile,
  async listMessages(accessToken, options) {
    const result = await listMessages(accessToken, {
      query: options.query,
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return {
      refs: (result.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })),
      nextPageToken: result.nextPageToken,
    };
  },
  async getMessage(accessToken, id) {
    return normalizeMessage(await getMessage(accessToken, id));
  },
};
```

**Verify:** `bun run typecheck` passes — this is what actually proves `gmailProvider` satisfies `EmailProvider` structurally; a mismatch fails compilation, not a test. Then `bun test` — the full existing Gmail suite still passes, confirming "behavior unchanged" held.

---

## Step 9 — Connect a Zoho mailbox (operational, not a file)

**Why this step exists.** `convex/assistant.ts`'s `/connect` command (`connectCommand`) is hardcoded today to build only `https://<site>/oauth/google/start?state=...` links — it has no provider argument, and neither does `/reconnect`, which calls the same function. Teaching it about Zoho (`/connect zoho recruiting`) is a small, real edit — but `convex/assistant.ts` is outside this phase's file manifest, so it isn't made here. Until it is, connect a Zoho mailbox by hand:

**1. Set the redirect URI.** `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` are already provisioned on the dev deployment (confirmed via `.env.dev`), but `ZOHO_REDIRECT_URI` is not:

```bash
bunx convex env set ZOHO_REDIRECT_URI "https://<dev>.convex.site/oauth/zoho/callback"
```

This exact URL must also be registered, character-for-character, as the redirect URI for your Zoho API console's connected app — the standard OAuth requirement, same as `GOOGLE_REDIRECT_URI` needed for Gmail.

**2. Mint a nonce by hand.** Find your `users._id` in the Convex dashboard (there's only one row — this is a single-owner assistant), then:

```bash
bunx convex run model/oauthStates:issue '{"userId":"<your users._id>","label":"personal"}'
```

This returns `{ nonce, expiresAt }`. The nonce is single-use and expires in 10 minutes, same as every Gmail connect link.

**3. Visit the start URL.**

```
https://<dev>.convex.site/oauth/zoho/start?state=<nonce>
```

Approve at Zoho's consent screen. You land on `/oauth/zoho/callback`, which schedules `internal.zoho.completeConnect` and returns immediately — the real confirmation arrives in Telegram a moment later, same pattern as Gmail's callback.

**4. Confirm.** Convex dashboard → `connectedAccounts` has a new row with `provider: "zoho"`, `status: "ACTIVE"`. `emailMessages` gains rows from that account within a few seconds of the confirmation message.

---

## Done when

- [ ] `bun test` — the new `zoho-normalize.test.ts` suite passes, and the existing Gmail suite still passes unchanged
- [ ] `bun run typecheck` — clean, including `gmailProvider`'s structural match against `EmailProvider`
- [ ] `bunx convex dev` pushes without error
- [ ] `ZOHO_REDIRECT_URI` is set on dev and matches a redirect URI registered in the Zoho API console
- [ ] A real Zoho mailbox connects via Step 9 — Telegram confirmation arrives, `connectedAccounts` has a `provider: "zoho"` row
- [ ] `emailMessages` has rows from that account after a sync; a message actually sitting in the mailbox's Junk/Spam folder shows `labelIds` containing `"SPAM"` — the acceptance bar, checked for real, not just in the unit test
- [ ] The `mailbox sync waking`/`overnight` crons in `convex/crons.ts` still only touch Gmail accounts — this phase deliberately does not add a Zoho cron entry (see "Next")
- [ ] `gmail.syncAll` no longer attempts to sync a non-Gmail account — confirm by reading the diff, not just by the absence of an error (there's nothing to error on with zero Zoho crons wired up yet)

**The exit criterion this phase inherits from the plan** — *"a message in Zoho's junk folder produces the same badged Telegram card as a Gmail SPAM message, and a reply sends from the correct Zoho account"* — is **not fully checkable yet**. Badged cards are Phase 5; sending is Phase 6. What's checkable today, and checked above: the same message produces the same `labelIds` signal a badge would key off, through the same normalization contract, in the same table, via the same providerless `emailMessages.upsert` mutation Gmail uses. That's the part of the claim this phase actually proves.

```bash
git add -A && git commit -m "Phase 15: Zoho Mail connector, second EmailProvider implementation"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/lib/email/provider.ts` | The shared `EmailProvider` contract, extracted from Gmail's real shape. |
| `convex/connectors/zoho/oauth.ts` | Speaks Zoho's OAuth 2.0 handshake. Nothing else in the codebase does. |
| `convex/connectors/zoho/client.ts` | Speaks Zoho Mail's REST API. Nothing else in the codebase does. |
| `convex/connectors/zoho/normalize.ts` | Pure Zoho → `NormalizedEmail` extraction, including the junk→`SPAM` mapping. |
| `convex/zoho.ts` | Connect, sync one account, sync all Zoho accounts. |
| `convex/http.ts` | Front door — now redirects two providers into OAuth, not one. |
| `convex/gmail.ts` | Gmail's own sync, now provider-filtered, plus its formal `EmailProvider` value. |
| `tests/unit/zoho-normalize.test.ts` | Proves the junk-folder abstraction survives a second provider. |

---

## Next

Three things this phase deliberately left for later, named rather than buried:

1. **`convex/crons.ts` gets no Zoho entry here.** `zoho.syncAll` exists and works when called by hand or via the dashboard, but nothing schedules it yet. Adding `crons.cron("zoho mailbox sync", "*/10 4-21 * * *", internal.zoho.syncAll, {})` alongside the existing Gmail crons is a one-line follow-up once you've verified Step 9 end-to-end — deliberately not bundled into this phase's file manifest.
2. **`/connect` and `/reconnect` don't know about Zoho.** Step 9's manual nonce-minting is the honest stand-in until `convex/assistant.ts`'s `connectCommand` takes a provider argument.
3. **Zoho isn't routed through `EmailProvider` yet**, only Gmail is (Step 8's note explains why). Phase 8's push/reconciliation work is the natural point to build a real shared sync loop and finish wiring Zoho through it, since that phase already has to restructure `syncAccount`/`syncAll` for webhooks regardless of provider count.

**Phase 16 — Linear**, if and only if internal task tracking turns out to be insufficient — the source plan's own framing, kept rather than presented as an unconditional next step.
