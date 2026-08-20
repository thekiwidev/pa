# Phase 8 — Push notifications, reconciliation, email actions

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** `docs/personal-ai-assistant-build-plan-v3-convex.md` → *Phase 8*
- **Prerequisite:** Phase 7 complete — three Gmail mailboxes connected, priority rules applied as code, and (per Phase 6) the consequential-tool approval gate in `convex/tools/router.ts` is a real approval desk, not the unconditional-refusal stub.

> **A note on where this phase actually starts from.** At the time this doc was written, the real `convex/` tree has only Phases 0–3 executed — `bun test` passes, `syncAccount` polls one mailbox, but nothing classifies, nothing alerts, nothing drafts or sends, and `convex/tools/router.ts`'s consequential branch still unconditionally refuses. Phases 4, 5, and 7 exist as build docs (`docs/build/PHASE-04-importance-classification.md`, `PHASE-05-alerts-and-summaries.md`, `PHASE-07-three-mailboxes.md`) but have not been run against this codebase yet, and **Phase 6 (draft, approve, send) does not yet have its own build doc at all.** This phase's steps below are written against the state Phase 4, 5, and 7's own docs specify — quoted and matched exactly against those files — and, where Phase 6 would normally have supplied something (the approval gate's internals, a `sendMessage`/MIME wrapper), against the source plan's Phase 6 design, called out explicitly at each such point rather than invented silently. **Run Phases 4 through 7 for real, in order, before this one** — several of the "current file" snippets below assume code that plan puts in place, and it will not be there yet if you jump straight here.

---

## What you'll have at the end

An important email from any of your three mailboxes reaches Telegram within about a minute of landing — pushed, not polled for. If Gmail ever stops telling you (a watch expires, a token gets revoked), you get a Telegram alert about *that*, not silence. And the assistant can act on mail, not just describe it: label, archive, mark read/unread, pull something out of spam, forward, unsubscribe, trash — every one of the risky ones behind the same approval tap `[Send]` already requires. There is no delete tool. There never will be.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 1 | `convex/connectors/gmail/pubsub.ts` | new | Verifies the Pub/Sub push's OIDC JWT; parses the envelope |
| 2 | `convex/model/webhookEvents.ts` | new | Idempotency: check-then-insert on `externalId` |
| 3 | `convex/model/syncCursors.ts` | new | Per-account `lastHistoryId` / failure-streak bookkeeping |
| 4 | `convex/http.ts` | edit | `POST /webhooks/gmail` |
| 5 | `convex/connectors/gmail/client.ts` | edit | `watch`, `historyList`, `modifyMessage`, `trashMessage`, `sendRaw` |
| 6 | `convex/connectors/gmail/oauth.ts` | edit | `GMAIL_MODIFY_SCOPES` — the third scope constant |
| 7 | `convex/model/connectedAccounts.ts` | edit | `recordWatch` — stores what `users.watch` returns |
| 8 | `convex/model/emailMessages.ts` | edit | `setLabels` — keeps the local cache honest after a modify/trash call |
| 9 | `convex/gmail.ts` | edit | `syncFromHistory`, `watch`, `renewWatch`, and the nine action executors |
| 10 | `convex/crons.ts` | edit | Daily watch renewal, 6-hourly safety net; retires the old 10/30-min polling |
| 11 | `convex/lib/config.ts` | edit | `REQUIRED_NOW` grows by three Pub/Sub variables |
| 12 | `convex/lib/prompts/assistant.ts` | edit | `SCOPE` — email is no longer read-only |
| 13 | `convex/lib/tools/catalog.ts` | edit | Nine new tool schemas |
| 14 | `convex/tools/router.ts` | edit | Nine new dispatch cases, one shared ownership helper |
| 15 | `convex/lib/tools/outcomes.ts` | edit | Nine new renderers |
| 16 | `tests/unit/no-hard-delete-tool.test.ts` | new | Asserts the registry has no delete tool, and never will |
| 17 | `tests/adversarial/webhook-idempotency.test.ts` | new | Adversarial #8, #21 |

Files 7 and 8 are small additions not named in the original phase brief, needed because every other file that calls the live Gmail API in this codebase is `convex/gmail.ts`, and its actions need somewhere to persist what they did — adding them here keeps that rule intact rather than letting `convex/tools/router.ts` reach into Gmail directly.

---

## Step 1 — Pub/Sub setup, exactly as Google requires it (verified 19 Aug 2026)

**Not a file — four `gcloud`/console steps, once, outside any deployment.**

```text
1. Create topic:         projects/adedotun-personal-assistant/topics/gmail-push
2. Grant Pub/Sub Publisher on that topic to:
                         gmail-api-push@system.gserviceaccount.com
   (if an org policy on domain-restricted sharing blocks this, add an exception)
3. Create a PUSH subscription, with OIDC authentication, targeting this deployment:
   gcloud pubsub subscriptions create gmail-push-sub \
     --topic=gmail-push \
     --push-endpoint="https://<deployment>.convex.site/webhooks/gmail" \
     --push-auth-service-account=gmail-api-push@system.gserviceaccount.com \
     --push-auth-token-audience="https://<deployment>.convex.site/webhooks/gmail"
4. Per mailbox, once Step 9 below is deployed: internal.gmail.watch stores the
   returned historyId and expiration on ConnectedAccount.
```

**Do not set `labelIds: ["INBOX"]` on `watch`.** With `labelIds` omitted, all changes are pushed — which is what you need for SPAM. If you ever do need filtering, use `labelFilterBehavior: "exclude"` with the labels you want to skip; the older `labelFilterAction` field is deprecated and produced incorrect behaviour in some cases.

Three environment variables come out of this and are consumed starting at Step 1 below and required by Step 11:

- `GOOGLE_PUBSUB_TOPIC` — the full topic name, e.g. `projects/adedotun-personal-assistant/topics/gmail-push`.
- `GOOGLE_PUBSUB_AUDIENCE` — exactly the `--push-auth-token-audience` value above; this is what the JWT's `aud` claim is checked against.
- `GOOGLE_PUBSUB_SA_EMAIL` — `gmail-api-push@system.gserviceaccount.com`; this is what the JWT's `email` claim is checked against, so an OIDC token from some *other* Google service cannot pass verification just because it is validly signed.

```bash
bunx convex env set GOOGLE_PUBSUB_TOPIC "projects/adedotun-personal-assistant/topics/gmail-push"
bunx convex env set GOOGLE_PUBSUB_AUDIENCE "https://<deployment>.convex.site/webhooks/gmail"
bunx convex env set GOOGLE_PUBSUB_SA_EMAIL "gmail-api-push@system.gserviceaccount.com"
```

Run this once per deployment (dev and prod each need their own subscription pointing at their own `.convex.site` URL).

---

## Step 2 — Verify the push, before trusting anything in it

**File:** `convex/connectors/gmail/pubsub.ts` **(create)**

**What this file is for.** Every POST to `/webhooks/gmail` claims to be Google. Believing that claim without checking it is how an unauthenticated request gets to trigger a Gmail history scan and, eventually, a Telegram alert. Pub/Sub's push mechanism has no shared-secret header the way Telegram does — the equivalent here is an OIDC identity token in the `Authorization` header, and verifying it means checking its signature against Google's own public keys, not just decoding the payload and trusting what it says.

No npm JWT library — `crypto.subtle.verify` against a short in-memory cache of Google's JWKS is a few dozen lines and keeps this file in the 64 MB V8 runtime, the same reasoning as every other file under `connectors/`.

```ts
// Verifies the Pub/Sub push envelope's OIDC identity token and parses the
// message payload. No npm JWT library -- crypto.subtle.verify against
// Google's own JWKS is a handful of lines and keeps this in the 64 MB V8
// runtime, same reasoning as every other connectors/ file.
//
// An unauthenticated POST here must never reach anything past this file --
// no history scan, no scheduled sync, nothing. Verification happens BEFORE
// the body is even parsed as a Pub/Sub envelope.

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
}

interface JwksCache {
  keys: Jwk[];
  expiresAt: number;
}

// Module-level, so it only helps within one warm V8 isolate -- Convex gives
// no cross-invocation state, but Google's certs rotate on the order of
// weeks, not seconds, so even a cold cache every time is one extra fetch,
// never a correctness problem.
let cache: JwksCache | null = null;

async function fetchJwks(): Promise<Jwk[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.keys;

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
  const json = (await res.json()) as { keys: Jwk[] };

  cache = { keys: json.keys, expiresAt: Date.now() + 10 * 60_000 };
  return cache.keys;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

export interface VerifiedPush {
  email: string;
}

/**
 * Checks signature, issuer, expiry, audience, and that the token names the
 * EXACT service account this project's subscription was created with -- not
 * merely "some validly-signed Google token", which would let a push from a
 * different Google product or a different Pub/Sub subscription through.
 *
 * Returns null on ANY failure. The caller's job is to turn null into a 401
 * and nothing else -- this function never throws for a malformed or forged
 * token, only for genuine infrastructure failure (the JWKS fetch itself).
 */
export async function verifyPubSubJwt(request: Request): Promise<VerifiedPush | null> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  let jwtHeader: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    jwtHeader = decodeJwtPart(headerPart!) as { kid?: string; alg?: string };
    payload = decodeJwtPart(payloadPart!);
  } catch {
    return null;
  }
  if (jwtHeader.alg !== "RS256" || !jwtHeader.kid) return null;

  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === jwtHeader.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signedContent = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = base64UrlToBytes(signaturePart!);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedContent,
  );
  if (!validSignature) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.iss !== "string" || !ISSUERS.has(payload.iss)) return null;

  const expectedAudience = process.env.GOOGLE_PUBSUB_AUDIENCE;
  if (!expectedAudience || payload.aud !== expectedAudience) return null;

  const expectedEmail = process.env.GOOGLE_PUBSUB_SA_EMAIL;
  if (!expectedEmail || payload.email !== expectedEmail) return null;
  if (payload.email_verified !== true) return null;

  return { email: payload.email };
}

export interface PubSubEnvelope {
  emailAddress: string;
  historyId: string;
  messageId: string;
}

/**
 * The push body is `{ message: { data: <base64 JSON>, messageId, ... },
 * subscription }`. `data` decodes to exactly `{ emailAddress, historyId }`
 * -- Gmail's watch topic never publishes the message content itself, only
 * enough to know whose mailbox changed and where to resume from.
 */
export function parsePubSubEnvelope(raw: string): PubSubEnvelope | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }

  const message = (body as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const m = message as { data?: unknown; messageId?: unknown };
  if (typeof m.data !== "string") return null;

  let decoded: { emailAddress?: unknown; historyId?: unknown };
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(m.data)));
  } catch {
    return null;
  }
  if (typeof decoded.emailAddress !== "string") return null;
  if (typeof decoded.historyId !== "string" && typeof decoded.historyId !== "number") return null;

  return {
    emailAddress: decoded.emailAddress,
    historyId: String(decoded.historyId),
    messageId: typeof m.messageId === "string" ? m.messageId : "",
  };
}
```

**Verify:** `bun run typecheck` — clean. Nothing calls this yet.

---

## Step 3 — Idempotency: the same push twice must be one row

**File:** `convex/model/webhookEvents.ts` **(create)**

**What this file is for.** Pub/Sub is at-least-once by design — the same push can and will arrive twice. `webhookEvents` (already in `schema.ts` since Phase 0's scaffold, unused until now) is the idempotency ledger: check the `by_external_id` index, then insert, inside one mutation. Mutations are ACID transactions on Convex, so that check-then-insert is genuinely atomic — no race, no `ON CONFLICT` needed, and no lock to reason about.

```ts
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * The idempotency gate for every at-least-once delivery this system accepts
 * (Pub/Sub today; nothing else yet). Check-then-insert inside one mutation --
 * a duplicate delivery arriving in the same millisecond still produces
 * exactly one row, because mutations are transactions.
 */
export const record = internalMutation({
  args: {
    source: v.string(), // "gmail_pubsub"
    externalId: v.string(), // Pub/Sub messageId
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
      .unique();

    if (existing) return { isNew: false, webhookEventId: existing._id };

    const webhookEventId = await ctx.db.insert("webhookEvents", {
      source: args.source,
      externalId: args.externalId,
      payload: args.payload,
    });
    return { isNew: true, webhookEventId };
  },
});

export const markProcessed = internalMutation({
  args: { webhookEventId: v.id("webhookEvents") },
  handler: async (ctx, args) => {
    await ctx.db.patch("webhookEvents", args.webhookEventId, { processedAt: Date.now() });
  },
});
```

**Verify:** `bun run typecheck` — clean.

---

## Step 4 — Where each account's incremental sync resumes from

**File:** `convex/model/syncCursors.ts` **(create)**

**What this file is for.** `syncCursors` (also already in `schema.ts`, unused) holds one row per account: the last `historyId` an incremental sync successfully applied, when the last full resync ran, when the last push arrived, and a consecutive-failure counter that both the history-fallback path and the watch-renewal path in Step 9 feed.

```ts
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const get = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("syncCursors")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
  },
});

/**
 * Upsert-by-account. Every field is optional so a caller can patch just the
 * one thing it knows about -- a push updates lastPushAt, a full resync
 * updates lastFullSyncAt and lastHistoryId, a failure increments
 * consecutiveFailures -- without clobbering the rest of the row.
 */
export const update = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    lastHistoryId: v.optional(v.string()),
    lastFullSyncAt: v.optional(v.number()),
    lastPushAt: v.optional(v.number()),
    resetFailures: v.optional(v.boolean()),
    incrementFailures: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("syncCursors")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();

    const patch: Record<string, unknown> = {};
    if (args.lastHistoryId !== undefined) patch.lastHistoryId = args.lastHistoryId;
    if (args.lastFullSyncAt !== undefined) patch.lastFullSyncAt = args.lastFullSyncAt;
    if (args.lastPushAt !== undefined) patch.lastPushAt = args.lastPushAt;

    if (!existing) {
      return await ctx.db.insert("syncCursors", {
        accountId: args.accountId,
        consecutiveFailures: args.incrementFailures ? 1 : 0,
        ...patch,
      });
    }

    const consecutiveFailures = args.resetFailures
      ? 0
      : args.incrementFailures
        ? existing.consecutiveFailures + 1
        : existing.consecutiveFailures;

    await ctx.db.patch("syncCursors", existing._id, { ...patch, consecutiveFailures });
    return existing._id;
  },
});
```

**Verify:** `bun run typecheck` — clean.

---

## Step 5 — The webhook route

**File:** `convex/http.ts` **(edit)**

**What this does.** Same three rules as `/webhooks/telegram` from Phase 1, and the same shape Phase 1's own comment already predicted ("This pattern repeats for the Gmail webhook in Phase 8"): verify the caller is really who it claims, make the check idempotent, acknowledge in milliseconds and do the real work in a scheduled action.

Add the import at the top, alongside the existing ones:

```ts
import { verifyPubSubJwt, parsePubSubEnvelope } from "./connectors/gmail/pubsub";
```

Add this route before `export default http;`, replacing the `// Phase 8 adds: POST /webhooks/gmail` comment:

```ts
/**
 * Gmail Pub/Sub push. Google POSTs here every time ANY change happens on a
 * watched mailbox -- new mail, a label change, a read/unread flip. The body
 * carries only an emailAddress and a historyId; the actual change is fetched
 * separately via history.list in convex/gmail.ts, never inferred from this
 * payload.
 *
 * Three things matter, the same shape as /webhooks/telegram:
 *   1. Verify the request really came from this project's Pub/Sub
 *      subscription -- an OIDC JWT, not a shared secret, because Pub/Sub
 *      offers no header-secret option the way Telegram does.
 *   2. Idempotency. Pub/Sub is at-least-once, so the SAME push can arrive
 *      twice. webhookEvents.record's check-then-insert makes a duplicate a
 *      no-op inside one transaction.
 *   3. Return 200 in milliseconds. A slow or non-2xx response makes Pub/Sub
 *      retry, and enough consecutive failures eventually suspends the
 *      subscription entirely -- silence dressed up as nothing happening.
 */
http.route({
  path: "/webhooks/gmail",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const verified = await verifyPubSubJwt(request);
    if (!verified) {
      await ctx.runMutation(internal.model.audit.record, {
        actor: "system",
        action: "gmail_webhook.reject_unverified",
        result: "denied",
      });
      return new Response("unauthorized", { status: 401 });
    }

    const raw = await request.text();
    const envelope = parsePubSubEnvelope(raw);
    if (!envelope) return new Response(null, { status: 200 }); // malformed, ack anyway

    const { isNew } = await ctx.runMutation(internal.model.webhookEvents.record, {
      source: "gmail_pubsub",
      externalId: envelope.messageId,
      payload: envelope,
    });

    if (isNew) {
      await ctx.scheduler.runAfter(0, internal.gmail.syncFromHistory, {
        emailAddress: envelope.emailAddress,
        historyId: envelope.historyId,
      });
    }

    return new Response(null, { status: 200 });
  }),
});
```

**Verify:** `bun run typecheck` passes. `bunx convex dev --once` pushes without error. Do not try to trigger this from Telegram — it only fires once Step 1's subscription and Step 9's `watch` action are both live; a manual `curl` with no valid `Authorization` header should get a `401`.

---

## Step 6 — Gmail client: watch, incremental history, modify, trash, raw send

**File:** `convex/connectors/gmail/client.ts` **(edit)**

**What this does.** Five new thin wrappers, following the file's existing `gmailFetch` pattern exactly — every mailbox action this phase adds (label, unlabel, mark read/unread, archive, un-spam) is really the *same* Gmail endpoint, `messages.modify`, called with different `addLabelIds`/`removeLabelIds`. Trash and raw-send are each their own endpoint.

Add these exports after `getMessage`, at the bottom of the file:

```ts
export interface WatchResponse {
  historyId: string;
  expiration: string; // ms-epoch, as a string -- Gmail's int64 convention
}

/**
 * Registers this mailbox for Pub/Sub push. Deliberately no labelIds --
 * omitting the filter is what makes SPAM (and every other label) push
 * through, the exact same principle as includeSpamTrash on listMessages.
 */
export async function watch(
  accessToken: string,
  options: { topicName: string },
): Promise<WatchResponse> {
  const res = await fetch(`${BASE}/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topicName: options.topicName }),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as WatchResponse;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: GmailMessageRef }[];
  labelsAdded?: { message: GmailMessageRef; labelIds: string[] }[];
  labelsRemoved?: { message: GmailMessageRef; labelIds: string[] }[];
}

export interface HistoryListResult {
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

/**
 * Incremental changes since startHistoryId. Gmail returns 404 when the id is
 * too old for the retained history window (about a week) -- the documented
 * signal to fall back to a full resync, not a bug in this code.
 */
export async function historyList(
  accessToken: string,
  options: { startHistoryId: string; pageToken?: string },
): Promise<HistoryListResult> {
  const params = new URLSearchParams({ startHistoryId: options.startHistoryId });
  if (options.pageToken) params.set("pageToken", options.pageToken);
  return await gmailFetch(accessToken, `/history?${params.toString()}`);
}

export interface ModifyResult {
  id: string;
  labelIds?: string[];
}

/**
 * The single endpoint behind label / unlabel / mark_read / mark_unread /
 * archive / mark_not_spam -- every one of those is just a different
 * addLabelIds/removeLabelIds combination on this same call.
 */
export async function modifyMessage(
  accessToken: string,
  id: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<ModifyResult> {
  const res = await fetch(`${BASE}/messages/${id}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as ModifyResult;
}

/**
 * Moves to Trash -- reversible for 30 days. There is deliberately no wrapper
 * anywhere in this file for messages.delete (permanent), and there never
 * will be; see tests/unit/no-hard-delete-tool.test.ts.
 */
export async function trashMessage(accessToken: string, id: string): Promise<ModifyResult> {
  const res = await fetch(`${BASE}/messages/${id}/trash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as ModifyResult;
}

/**
 * Sends an already base64url-encoded RFC 2822 message. Used for forwarding
 * and for a mailto: unsubscribe -- both compose a brand-new message rather
 * than reply inside an existing thread, so neither needs In-Reply-To or
 * References the way a Phase 6 reply does.
 */
export async function sendRaw(accessToken: string, raw: string): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as { id: string };
}
```

**Verify:** `bun run typecheck` — clean.

---

## Step 7 — The `gmail.modify` scope

**File:** `convex/connectors/gmail/oauth.ts` **(edit)**

**What this does.** At the time of writing, this file's actual scope list is still exactly what Phase 3 left it — `GMAIL_READONLY_SCOPES` only. (Phase 6 would normally have added a `GMAIL_SEND_SCOPES` constant here for reply-sending; if it has landed on your deployment by the time you reach this step, treat the block below as adding a *third* constant alongside it, per the source plan. If it hasn't, this step still stands on its own — the label/archive/mark-read/trash actions below need `gmail.modify` regardless of whether sending exists yet.)

Add this constant after `GMAIL_READONLY_SCOPES`:

```ts
/**
 * Phase 3 was read-only. Phase 6 adds gmail.compose + gmail.send for
 * replying. This phase adds gmail.modify -- the scope every mailbox action
 * below actually needs: label, archive, mark-read/unread, un-spam, and
 * trash all go through messages.modify or messages.trash, neither of which
 * gmail.send or gmail.compose authorizes on their own.
 *
 * Cumulative, not additive -- the point of one OAuth consent screen is
 * naming everything you want in it, not combining several grants later.
 * Never request https://mail.google.com/ -- that is full, unscoped access.
 */
export const GMAIL_MODIFY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;
```

Then change `authorizeUrl`'s scope line:

```diff
-    scope: GMAIL_READONLY_SCOPES.join(" "),
+    scope: GMAIL_MODIFY_SCOPES.join(" "),
```

**Operational step, not code:** Google does not retroactively widen an already-issued refresh token's scope. Every mailbox connected before this phase — all three, if you did Phase 7 — must be reconnected once for `gmail.modify` to actually be granted:

```
/reconnect personal
/reconnect recruiting
/reconnect client
```

`/accounts` afterward should show `gmail.modify` in each row's scope list.

**Verify:** `bun run typecheck` passes. After reconnecting one account, `/accounts` shows the new scope.

---

## Step 8 — Two small model-layer additions

**Files:** `convex/model/connectedAccounts.ts`, `convex/model/emailMessages.ts` **(edit)**

**What these do.** `recordWatch` stores what `users.watch` returns — distinct from `markSynced`, because renewing a watch is not itself a sync and should not move `lastSyncedAt`. `setLabels` keeps the locally-cached `labelIds` honest after any live modify/trash call, the same reasoning `upsert`'s existing comment already states for a re-sync ("labels are the one thing that legitimately changes").

Add to `convex/model/connectedAccounts.ts`, after `markNeedsReauth`:

```ts
/** Phase 8: stores the result of users.watch. Distinct from markSynced --
 *  a watch renewal is not a sync, and lastSyncedAt should not move just
 *  because the push registration was refreshed. */
export const recordWatch = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    historyId: v.string(),
    watchExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("connectedAccounts", args.accountId, {
      lastHistoryId: args.historyId,
      watchExpiresAt: args.watchExpiresAt,
    });
  },
});
```

Add to `convex/model/emailMessages.ts`, after `getById`:

```ts
/** Applied after any Gmail modify/trash call, so the cached labelIds never
 *  drift from what Gmail actually did. */
export const setLabels = internalMutation({
  args: { emailMessageId: v.id("emailMessages"), labelIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.patch("emailMessages", args.emailMessageId, { labelIds: args.labelIds });
  },
});
```

**Verify:** `bun run typecheck` — clean.

---

## Step 9 — `convex/gmail.ts`: push-driven sync, watch, and the action executors

**File:** `convex/gmail.ts` **(edit)**

This is the largest step. It assumes the file already contains what Phase 4's doc (`classifyMessage`, `CLASSIFIER_VERSION`) and Phase 5's doc (`deliverIfDue`) added inside `syncAccount`'s loop — this step does not touch that loop at all, it only adds new exports alongside it.

One honest wrinkle between those two already-written docs, resolved here rather than propagated: Phase 5's doc assumes a `classified` object is "left in scope" by Phase 4's block, but Phase 4's actual `classifyMessage` function returns `void` — it writes the classification onto the row and nothing else. The helper below sidesteps that by reading the row back after classifying, rather than assuming a variable is still in scope. This also means the same helper can drive both `syncAccount`'s polling loop's *equivalent* logic and this phase's push path without duplicating either.

### Imports

Add these to the top of the file, alongside the existing ones:

```ts
import {
  getProfile,
  listMessages,
  getMessage,
  watch as watchGmail,
  historyList,
  modifyMessage,
  trashMessage as trashViaGmailApi,
  sendRaw,
  GmailApiError,
} from "./connectors/gmail/client";
```

(This replaces the existing, narrower `getProfile, listMessages, getMessage, GmailApiError` import line — everything else already at the top of the file stays exactly as it is.)

### The shared per-message pipeline

Add this near the top of the file, after the existing `MAX_PER_SYNC` constant:

```ts
const FULL_RESYNC_WINDOW = "newer_than:7d";

/**
 * Fetch, normalize, upsert, classify, and (if due) alert -- for a batch of
 * already-known message ids. Shared by the full-resync fallback below and
 * by syncFromHistory's incremental path, so classification and delivery can
 * never drift between "found via history.list" and "found via a fresh
 * listMessages page".
 */
async function processMessageRefs(
  ctx: ActionCtx,
  account: { _id: Id<"connectedAccounts">; userId: Id<"users">; label: string },
  accessToken: string,
  refs: { id: string }[],
): Promise<{ stored: number; fresh: number }> {
  let stored = 0;
  let fresh = 0;

  for (const ref of refs) {
    const full = await getMessage(accessToken, ref.id);
    const normalized = normalizeMessage(full);
    const { bodyTruncated: _bodyTruncated, ...row } = normalized;

    const result = await ctx.runMutation(internal.model.emailMessages.upsert, {
      accountId: account._id,
      ...row,
    });
    stored++;
    if (!result.created) continue;
    fresh++;

    await classifyMessage(ctx, account.userId, result.emailMessageId, normalized);

    // classifyMessage writes importance/classification onto the row and
    // returns nothing -- read it back rather than assume a variable is
    // still in scope from Phase 4's block.
    const classified = await ctx.runQuery(internal.model.emailMessages.getById, {
      emailMessageId: result.emailMessageId,
    });
    if (classified?.importance) {
      const detail = classified.classification as
        | { whyItMatters?: string; deadlineMentioned?: string | null }
        | undefined;
      await deliverIfDue(ctx, account, result.emailMessageId, normalized, {
        importance: classified.importance,
        whyItMatters: detail?.whyItMatters,
        deadlineMentioned: detail?.deadlineMentioned,
      });
    }
  }

  return { stored, fresh };
}

/** Last 7 days, spam and trash included -- the documented fallback when
 *  history.list can no longer serve an incremental diff. */
async function fullResync(
  ctx: ActionCtx,
  account: { _id: Id<"connectedAccounts">; userId: Id<"users">; label: string },
  accessToken: string,
): Promise<void> {
  const listed = await listMessages(accessToken, {
    query: FULL_RESYNC_WINDOW,
    maxResults: MAX_PER_SYNC,
  });
  const { fresh } = await processMessageRefs(ctx, account, accessToken, listed.messages ?? []);

  const profile = await getProfile(accessToken);
  await ctx.runMutation(internal.model.syncCursors.update, {
    accountId: account._id,
    lastHistoryId: profile.historyId,
    lastFullSyncAt: Date.now(),
    resetFailures: true,
  });
  await ctx.runMutation(internal.model.connectedAccounts.markSynced, {
    accountId: account._id,
    lastHistoryId: profile.historyId,
  });

  await ctx.runMutation(internal.model.audit.record, {
    actor: "scheduler",
    action: "gmail.full_resync",
    targetType: "connectedAccounts",
    targetId: account._id,
    args: { new: fresh, window: FULL_RESYNC_WINDOW },
    result: "ok",
  });
}
```

### `syncFromHistory` — the webhook's actual target

Add this after `syncAll`:

```ts
/**
 * The webhook's scheduled target. Resolves the mailbox by address (Pub/Sub
 * has no concept of our internal accountId), then walks history.list from
 * the stored cursor -- or falls back to a full 7-day resync when there is
 * no cursor yet, or when Gmail says the cursor has aged out (a 404).
 */
export const syncFromHistory = internalAction({
  args: { emailAddress: v.string(), historyId: v.string() },
  handler: async (ctx, args) => {
    const startedAt = Date.now();

    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    const account = accounts.find(
      (a) => a.accountEmail.toLowerCase() === args.emailAddress.toLowerCase(),
    );
    if (!account) {
      console.warn(`gmail_push_unknown_account email=${args.emailAddress}`);
      return;
    }

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, account._id);
    } catch (error) {
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(ctx, account.userId, account._id, account.accountEmail);
        return;
      }
      throw error;
    }

    const cursor = await ctx.runQuery(internal.model.syncCursors.get, { accountId: account._id });
    const startHistoryId = cursor?.lastHistoryId ?? account.lastHistoryId;

    if (!startHistoryId) {
      // No cursor at all -- this account has never completed a sync with a
      // stored historyId. Treat it exactly like a stale one: full resync.
      await fullResync(ctx, account, accessToken);
      return;
    }

    try {
      let pageToken: string | undefined;
      let newestHistoryId = startHistoryId;
      let totalFresh = 0;

      do {
        const page = await historyList(accessToken, { startHistoryId, pageToken });
        newestHistoryId = page.historyId ?? newestHistoryId;
        pageToken = page.nextPageToken;

        const refs = (page.history ?? []).flatMap((h) => [
          ...(h.messagesAdded ?? []).map((m) => m.message),
          // A label change -- read/unread, moved to/from SPAM -- still needs
          // its row re-synced. emailMessages.upsert already patches labelIds
          // on an existing row rather than only inserting new ones.
          ...(h.labelsAdded ?? []).map((m) => m.message),
          ...(h.labelsRemoved ?? []).map((m) => m.message),
        ]);

        // De-dupe within the page -- the same message can appear under both
        // messagesAdded and labelsAdded in one history record.
        const unique = [...new Map(refs.map((r) => [r.id, r])).values()];

        const { fresh } = await processMessageRefs(ctx, account, accessToken, unique);
        totalFresh += fresh;
      } while (pageToken);

      await ctx.runMutation(internal.model.syncCursors.update, {
        accountId: account._id,
        lastHistoryId: newestHistoryId,
        lastPushAt: Date.now(),
        resetFailures: true,
      });
      await ctx.runMutation(internal.model.connectedAccounts.markSynced, {
        accountId: account._id,
        lastHistoryId: newestHistoryId,
      });

      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "gmail.sync_from_history",
        targetType: "connectedAccounts",
        targetId: account._id,
        args: { new: totalFresh, startHistoryId },
        result: "ok",
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      // history.list 404s when startHistoryId has aged out of Gmail's
      // retained window (about a week) -- not a bug, the documented signal
      // to fall back to a full resync.
      if (error instanceof GmailApiError && error.status === 404) {
        await ctx.runMutation(internal.model.syncCursors.update, {
          accountId: account._id,
          incrementFailures: true,
        });
        await fullResync(ctx, account, accessToken);
        return;
      }
      if (error instanceof GmailApiError && error.isAuthFailure) {
        await notifyNeedsReauth(ctx, account.userId, account._id, account.accountEmail);
        return;
      }
      await ctx.runMutation(internal.model.syncCursors.update, {
        accountId: account._id,
        incrementFailures: true,
      });
      throw error;
    }
  },
});
```

### `watch` and `renewWatch`

Add these after `syncFromHistory`:

```ts
export const watch = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status !== "ACTIVE") return;

    const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
    if (!topicName) throw new Error("GOOGLE_PUBSUB_TOPIC is not set on this deployment");

    try {
      const accessToken = await accessTokenFor(ctx, args.accountId);
      const result = await watchGmail(accessToken, { topicName });

      await ctx.runMutation(internal.model.connectedAccounts.recordWatch, {
        accountId: args.accountId,
        historyId: result.historyId,
        watchExpiresAt: Number(result.expiration),
      });
      await ctx.runMutation(internal.model.syncCursors.update, {
        accountId: args.accountId,
        resetFailures: true,
      });
      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "gmail.watch",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: { expiresAt: Number(result.expiration) },
        result: "ok",
      });
    } catch (error) {
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(ctx, account.userId, args.accountId, account.accountEmail);
        return;
      }

      await ctx.runMutation(internal.model.syncCursors.update, {
        accountId: args.accountId,
        incrementFailures: true,
      });

      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "gmail.watch",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: {},
        result: "error",
        errorMessage: detail.slice(0, 500),
      });

      // Two failed renewals in a row -- the exact threshold the source plan
      // names. A silently expired watch looks identical to a quiet inbox,
      // so this is the one failure mode that pages even though nothing
      // "broke" in the usual crash sense.
      const cursor = await ctx.runQuery(internal.model.syncCursors.get, {
        accountId: args.accountId,
      });
      if ((cursor?.consecutiveFailures ?? 0) >= 2) {
        const user = await ctx.runQuery(internal.model.users.get, { userId: account.userId });
        if (user) {
          await sendMessage(
            user.telegramId,
            `⚠️ ${account.accountEmail} (${account.label}) — Gmail watch renewal has failed ` +
              `${cursor!.consecutiveFailures} times in a row. Push alerts for this mailbox may ` +
              `be silently stale; the 6-hourly safety-net sweep still covers it.`,
          );
        }
      }
      throw error;
    }
  },
});

/**
 * The cron target (Step 10). Renews any ACTIVE account whose watch is
 * missing or within 48 hours of expiring. Google requires a call at least
 * once every 7 days and recommends once a day -- daily plus this 48-hour
 * guard means a single missed tick is never the gap between "watching" and
 * "silently not".
 */
export const renewWatch = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    const RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000;

    await Promise.all(
      accounts
        .filter((a) => !a.watchExpiresAt || a.watchExpiresAt - Date.now() < RENEWAL_WINDOW_MS)
        .map(async (account) => {
          try {
            await ctx.runAction(internal.gmail.watch, { accountId: account._id });
          } catch (error) {
            console.warn(
              `gmail_watch_renew_failed account=${account._id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
    );
  },
});
```

### The nine action executors

Add these at the bottom of the file:

```ts
async function requireMessage(ctx: ActionCtx, emailMessageId: Id<"emailMessages">) {
  const message = await ctx.runQuery(internal.model.emailMessages.getById, { emailMessageId });
  if (!message) throw new Error("email message not found");
  const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
    accountId: message.accountId,
  });
  if (!account) throw new Error("account not found");
  return { message, account };
}

async function auditAction(
  ctx: ActionCtx,
  targetId: Id<"emailMessages">,
  action: string,
  args: Record<string, unknown>,
) {
  await ctx.runMutation(internal.model.audit.record, {
    actor: "llm_proposed",
    action,
    targetType: "emailMessages",
    targetId,
    args,
    result: "ok",
  });
}

export const applyLabel = internalAction({
  args: { emailMessageId: v.id("emailMessages"), gmailLabel: v.string() },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      addLabelIds: [args.gmailLabel],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.label", { label: args.gmailLabel });
  },
});

export const removeLabel = internalAction({
  args: { emailMessageId: v.id("emailMessages"), gmailLabel: v.string() },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      removeLabelIds: [args.gmailLabel],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.unlabel", { label: args.gmailLabel });
  },
});

export const markRead = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      removeLabelIds: ["UNREAD"],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.mark_read", {});
  },
});

export const markUnread = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      addLabelIds: ["UNREAD"],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.mark_unread", {});
  },
});

export const archiveMessage = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      removeLabelIds: ["INBOX"],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.archive", {});
  },
});

export const markNotSpam = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    const updated = await modifyMessage(accessToken, message.providerMessageId, {
      removeLabelIds: ["SPAM"],
      addLabelIds: ["INBOX"],
    });
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.mark_not_spam", {});
  },
});

export const trashMessage = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);
    // Trash, never delete -- reversible for 30 days. See
    // tests/unit/no-hard-delete-tool.test.ts for the registry-level guarantee.
    const updated = await trashViaGmailApi(accessToken, message.providerMessageId);
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds: updated.labelIds ?? [],
    });
    await auditAction(ctx, args.emailMessageId, "email.trash", {});
  },
});

export const forwardMessage = internalAction({
  args: {
    emailMessageId: v.id("emailMessages"),
    to: v.array(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);
    const accessToken = await accessTokenFor(ctx, account._id);

    const subject = message.subject ? `Fwd: ${message.subject}` : "Fwd: (no subject)";
    const body = [
      args.note ?? "",
      "---------- Forwarded message ----------",
      `From: ${message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}`,
      `Subject: ${message.subject ?? "(no subject)"}`,
      "",
      message.bodyText ?? message.snippet ?? "(no body)",
    ].join("\n");

    const raw = buildRawMessage({ from: account.accountEmail, to: args.to, subject, body });
    const sent = await sendRaw(accessToken, raw);

    await auditAction(ctx, args.emailMessageId, "email.forward", {
      to: args.to,
      sentMessageId: sent.id,
    });
    return { sentMessageId: sent.id };
  },
});

export const unsubscribeFromMessage = internalAction({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => {
    const { message, account } = await requireMessage(ctx, args.emailMessageId);

    // RFC 8058 one-click: List-Unsubscribe-Post must say "List-Unsubscribe=
    // One-Click", AND the List-Unsubscribe URL must be on the SENDER'S OWN
    // authenticated domain -- not just any https URL, which would let a
    // spoofed header point the "safe" automatic path at an attacker's
    // endpoint.
    const headerUrl = extractHttpUnsubscribeUrl(message.listUnsubscribe);
    const senderDomain = message.fromAddress.split("@")[1]?.toLowerCase();
    const canOneClick =
      message.listUnsubscribePost === "List-Unsubscribe=One-Click" &&
      headerUrl !== null &&
      senderDomain !== undefined &&
      new URL(headerUrl).hostname.toLowerCase().endsWith(senderDomain);

    if (canOneClick && headerUrl) {
      const res = await fetch(headerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      await auditAction(ctx, args.emailMessageId, "email.unsubscribe", {
        method: "one_click",
        status: res.status,
      });
      return { method: "one_click" as const };
    }

    const mailto = extractMailtoUnsubscribe(message.listUnsubscribe);
    if (mailto) {
      const accessToken = await accessTokenFor(ctx, account._id);
      const raw = buildRawMessage({
        from: account.accountEmail,
        to: [mailto],
        subject: "unsubscribe",
        body: "unsubscribe",
      });
      await sendRaw(accessToken, raw);
      await auditAction(ctx, args.emailMessageId, "email.unsubscribe", {
        method: "mailto",
        to: mailto,
      });
      return { method: "mailto" as const };
    }

    if (headerUrl) {
      // A bare HTTP link with no one-click confirmation, or on a domain that
      // does not match the sender: NEVER fetched server-side. An assistant
      // that follows arbitrary URLs found in email is a click-through
      // oracle -- present it, let the owner decide.
      await auditAction(ctx, args.emailMessageId, "email.unsubscribe", {
        method: "link_presented",
        url: headerUrl,
      });
      return { method: "link_presented" as const, url: headerUrl };
    }

    await auditAction(ctx, args.emailMessageId, "email.unsubscribe", { method: "none" });
    return { method: "none" as const };
  },
});

function extractHttpUnsubscribeUrl(header: string | undefined): string | null {
  if (!header) return null;
  const match = /<(https?:\/\/[^>]+)>/.exec(header);
  return match?.[1] ?? null;
}

function extractMailtoUnsubscribe(header: string | undefined): string | null {
  if (!header) return null;
  const match = /<mailto:([^>]+)>/.exec(header);
  return match?.[1]?.split("?")[0] ?? null;
}

/** Minimal RFC 2822 builder -- just enough for a forward or a mailto
 *  unsubscribe: no attachments, no reply threading. A forward is
 *  deliberately a NEW thread, unlike a Phase 6 reply. */
function buildRawMessage(fields: {
  from: string;
  to: string[];
  subject: string;
  body: string;
}): string {
  const headers = [
    `From: ${fields.from}`,
    `To: ${fields.to.join(", ")}`,
    `Subject: ${fields.subject}`,
    "Content-Type: text/plain; charset=utf-8",
  ].join("\r\n");
  return base64UrlEncode(`${headers}\r\n\r\n${fields.body}`);
}

/** Same chunking as channels/telegram.ts's toBase64 -- String.fromCharCode
 *  on the whole buffer at once throws RangeError past ~100 KB. */
function base64UrlEncode(text: string): string {
  const CHUNK = 0x8000;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
```

**Verify:**
1. `bun run typecheck` passes.
2. `bunx convex dev --once` pushes without error.
3. `bunx convex run gmail:watch '{"accountId":"<id>"}'` against dev, for each connected account — `/accounts` afterward should show a fresh `watchExpiresAt` about 7 days out.
4. Send yourself a test email, wait under a minute, confirm the alert arrives — this is the actual push path firing end to end, not `/sync`.
5. `bunx convex run gmail:syncFromHistory '{"emailAddress":"<your address>","historyId":"1"}'` — an absurdly old historyId should trigger the 404 branch and a visible full resync in the logs.

---

## Step 10 — Crons: renew the watch, retire frequent polling for a safety net

**File:** `convex/crons.ts` **(edit)**

**What this does.** Push now carries the real-time job, so the two frequent polling crons from Phase 3 (`*/10` during the day, `*/30` overnight) are exactly the cost Phase 8 exists to cut — "you stop running a sync that finds nothing 90% of the time." They're replaced by a single 6-hourly safety net, which does the same bounded `listMessages` walk `syncAll` already does, plus a new daily watch-renewal job.

Replace the two Phase 3 lines:

```diff
-// Phase 3 — mailbox sync. UTC: Lagos is UTC+1, so 05-22 WAT is 04-21 UTC.
-crons.cron("mailbox sync waking", "*/10 4-21 * * *", internal.gmail.syncAll, {});
-crons.cron("mailbox sync overnight", "*/30 22,23,0-3 * * *", internal.gmail.syncAll, {});
-// Phase 8 adds: daily Gmail watch renewal
+// Phase 8 — push replaces frequent polling. UTC: Lagos is UTC+1, so 03:00
+// WAT is 02:00 UTC. Renewal must run at least once every 7 days (Google's
+// hard requirement) and Google recommends once a day; the safety-net sweep
+// runs regardless of push health -- four invocations a day, cheap
+// insurance against a watch that silently died between renewals.
+crons.cron("gmail watch renewal", "0 2 * * *", internal.gmail.renewWatch, {});
+crons.cron("gmail safety net sweep", "0 */6 * * *", internal.gmail.syncAll, {});
```

**Verify:** `bun run typecheck` passes. `bunx convex dashboard` → Crons shows exactly these two Gmail entries, plus the unchanged `reconcile missed reminders` from Phase 2.

---

## Step 11 — Three new required variables

**File:** `convex/lib/config.ts` **(edit)**

**What this does.** `REQUIRED_NOW` is what `/health` checks — this file's own comment already named the three variables Step 1 provisions, left as a breadcrumb. Wire them in for real.

```diff
-// Phase 8 adds: GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_AUDIENCE,
-//               GOOGLE_PUBSUB_SA_EMAIL
 export const REQUIRED_NOW: readonly string[] = [
   "ENCRYPTION_KEY",          // Phase 0
   "TELEGRAM_BOT_TOKEN",      // Phase 1
   "TELEGRAM_WEBHOOK_SECRET",
   "TELEGRAM_OWNER_ID",
   "AI_PROVIDER_PRIORITY",
   "GEMINI_API_KEY",
   "GEMINI_MODEL_REASON",           // chat + compose
   "GEMINI_MODEL_CHEAP_STRUCTURED", // PLAN_TOOLS — every inbound message
   "USER_TIMEZONE",           // Phase 2
   "GEMINI_MODEL_TRANSCRIBE", // Phase 9 — voice notes
   "GOOGLE_CLIENT_ID",        // Phase 3 — Gmail OAuth
   "GOOGLE_CLIENT_SECRET",
   "GOOGLE_REDIRECT_URI",
+  "GOOGLE_PUBSUB_TOPIC",     // Phase 8 — Gmail push
+  "GOOGLE_PUBSUB_AUDIENCE",
+  "GOOGLE_PUBSUB_SA_EMAIL",
 ];
```

**Verify:** `curl -s https://<dev>.convex.site/health | jq` still returns `configOk: true` once Step 1's three variables are set. If it flips `false` first, that confirms the check is live before you forget to set them.

---

## Step 12 — Tell the assistant email is no longer read-only

**File:** `convex/lib/prompts/assistant.ts` **(edit)**

**What this does.** The current `SCOPE` string's line reads:

```
  - NO tool for Calendar, Drive, Linear, WhatsApp, or sending/deleting email.
    These are not "not working yet" — they do not exist as tools at all.
```

That is no longer true for email. Replace it with:

```diff
-  - NO tool for Calendar, Drive, Linear, WhatsApp, or sending/deleting email.
-    These are not "not working yet" — they do not exist as tools at all.
+  - NO tool for Calendar, Drive, Linear, WhatsApp. These are not "not
+    working yet" — they do not exist as tools at all.
+  - Email is no longer read-only. A message can be labelled, marked
+    read/unread, archived, pulled out of spam, forwarded, unsubscribed, or
+    trashed (never permanently deleted — no such tool exists, ever). Every
+    one of those except label/unlabel/mark_read/mark_unread needs your
+    explicit approval before it happens, the same as sending — see the
+    consequential-action rule above. No amount of asking nicely, and no
+    saved standing instruction, skips that tap.
```

**Do not touch `tests/unit/assistant-prompt.test.ts` for this edit.** The one assertion that reads this line, `expect(prompt).toContain("Calendar, Drive, Linear, WhatsApp")`, is checking a substring that still appears verbatim in the new text — confirm this yourself by re-reading the diff above before moving on, per the standing rule in this project that a SCOPE edit and its test assertion are checked together, not assumed compatible.

**Verify:** `bun test tests/unit/assistant-prompt.test.ts` — still all passing, unmodified.

---

## Step 13 — Nine new tools in the catalog

**File:** `convex/lib/tools/catalog.ts` **(edit)**

Add these to `TOOL_SCHEMAS`, after the existing `email.get_message` entry:

```ts
  "email.label": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
    gmailLabel: EMAIL_LABEL.describe("the Gmail label to apply, e.g. STARRED"),
  }),
  "email.unlabel": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
    gmailLabel: EMAIL_LABEL.describe("the Gmail label to remove"),
  }),
  "email.mark_read": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
  "email.mark_unread": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
  "email.archive": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
  "email.mark_not_spam": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
  "email.trash": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
  "email.forward": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
    to: z.array(z.string().min(3)).min(1).describe("recipient email addresses"),
    note: z.string().optional().describe("a short note to add above the forwarded content"),
  }),
  "email.unsubscribe": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
```

Add these to `TOOL_META`, in the same order:

```ts
  "email.label": {
    description: "Apply a Gmail label to a message (e.g. STARRED). Internal organization, reversible.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.unlabel": {
    description: "Remove a Gmail label from a message.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.mark_read": {
    description: "Mark a message read.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.mark_unread": {
    description: "Mark a message unread.",
    consequential: false,
    requiresAccountId: true,
  },
  "email.archive": {
    description:
      "Remove a message from the inbox (Gmail's Archive). Reversible, but still requires " +
      "your approval before it happens.",
    consequential: true,
    requiresAccountId: true,
  },
  "email.mark_not_spam": {
    description: "Move a message out of SPAM, back into the inbox.",
    consequential: true,
    requiresAccountId: true,
  },
  "email.trash": {
    description:
      "Move a message to Trash. Reversible for 30 days — this is NOT a permanent delete, " +
      "and there is no permanent-delete tool.",
    consequential: true,
    requiresAccountId: true,
  },
  "email.forward": {
    description: "Forward a message to new recipients, with an optional note.",
    consequential: true,
    requiresAccountId: true,
  },
  "email.unsubscribe": {
    description:
      "Unsubscribe from a mailing list using the message's own List-Unsubscribe header — " +
      "RFC 8058 one-click when it's genuinely one-click, or an approved mailto: request. " +
      "Never fetches an arbitrary HTTP link server-side — that is presented to you instead.",
    consequential: true,
    requiresAccountId: true,
  },
```

**Verify:** `bun run typecheck` — clean. `describeCatalog()` (exercised indirectly by `tests/unit/assistant-prompt.test.ts`) now lists all nine.

---

## Step 14 — Nine new dispatch cases

**File:** `convex/tools/router.ts` **(edit)**

**What this does.** Each new tool resolves its `emailMessageId` to a row, refuses if it belongs to a different user's account (an id is a proposal, not proof of access — the same rule `email.get_message` already enforces), then hands off to the matching `convex/gmail.ts` action. The five consequential ones (`archive`, `mark_not_spam`, `trash`, `forward`, `unsubscribe`) never reach `dispatch()` at all without a live approval — that check happens earlier, at the top of `executeToolCall`, and is generic over every tool's `TOOL_META.consequential` flag. **At the time of writing, that check in the real file is still the Phase 2 stub** ("This action needs your explicit approval, which is not built yet.") — Phase 6, whenever you write and run its own doc, is what replaces it with the real approval-desk logic. Nothing in this step touches that function; it only adds cases to the `dispatch()` switch below it, which is generic enough to need no change once Phase 6 lands.

Add this helper above `dispatch`:

```ts
/**
 * Every action tool below takes an emailMessageId. Resolve it once, and
 * refuse if the message belongs to a different user's account — an id is a
 * proposal, not proof of access, the same rule email.get_message enforces.
 */
async function requireOwnedMessage(
  ctx: ActionCtx,
  userId: Id<"users">,
  emailMessageId: string,
) {
  const message = await ctx.runQuery(internal.model.emailMessages.getById, {
    emailMessageId: emailMessageId as Id<"emailMessages">,
  });
  if (!message) throw new Error("no email matching that id");

  const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
    accountId: message.accountId,
  });
  if (!account || account.userId !== userId) throw new Error("no email matching that id");

  return { message, account };
}
```

Add these cases to `dispatch`'s `switch`, after `email.get_message`:

```ts
    case "email.label": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.applyLabel, {
        emailMessageId: message._id,
        gmailLabel: a.gmailLabel as string,
      });
      return { emailMessageId: message._id, gmailLabel: a.gmailLabel };
    }

    case "email.unlabel": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.removeLabel, {
        emailMessageId: message._id,
        gmailLabel: a.gmailLabel as string,
      });
      return { emailMessageId: message._id, gmailLabel: a.gmailLabel };
    }

    case "email.mark_read": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.markRead, { emailMessageId: message._id });
      return { emailMessageId: message._id };
    }

    case "email.mark_unread": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.markUnread, { emailMessageId: message._id });
      return { emailMessageId: message._id };
    }

    case "email.archive": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.archiveMessage, { emailMessageId: message._id });
      return { emailMessageId: message._id };
    }

    case "email.mark_not_spam": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.markNotSpam, { emailMessageId: message._id });
      return { emailMessageId: message._id };
    }

    case "email.trash": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      await ctx.runAction(internal.gmail.trashMessage, { emailMessageId: message._id });
      return { emailMessageId: message._id };
    }

    case "email.forward": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      const result = await ctx.runAction(internal.gmail.forwardMessage, {
        emailMessageId: message._id,
        to: a.to as string[],
        note: a.note as string | undefined,
      });
      return { emailMessageId: message._id, to: a.to, sentMessageId: result.sentMessageId };
    }

    case "email.unsubscribe": {
      const { message } = await requireOwnedMessage(ctx, userId, a.emailMessageId as string);
      const result = await ctx.runAction(internal.gmail.unsubscribeFromMessage, {
        emailMessageId: message._id,
      });
      return { emailMessageId: message._id, ...result };
    }
```

**Verify:** `bun run typecheck` passes. Once Phase 6's approval gate is real, `bunx convex run debug:planOnly '{"execute":true,"text":"mark that email from Sarah as read"}'` against dev should propose and execute `email.mark_read` with no approval prompt (non-consequential); the same for `"archive that email"` should come back "awaiting your approval" instead of executing — per the lesson already recorded for this project ("pure-renderer tests don't catch router wiring bugs"), this manual check against a real deployment is not optional.

---

## Step 15 — Nine new renderers

**File:** `convex/lib/tools/outcomes.ts` **(edit)**

Add these cases to `renderOne`'s `switch`, after `email.get_message`:

```ts
    case "email.label":
      return `🏷️ Labelled ${str(r, "gmailLabel") ?? ""}.`;

    case "email.unlabel":
      return `🏷️ Removed ${str(r, "gmailLabel") ?? ""}.`;

    case "email.mark_read":
      return "✅ Marked read.";

    case "email.mark_unread":
      return "📩 Marked unread.";

    case "email.archive":
      return "📥 Archived.";

    case "email.mark_not_spam":
      return "✅ Moved out of Spam.";

    case "email.trash":
      return "🗑️ Moved to Trash (recoverable for 30 days).";

    case "email.forward": {
      const to = field(r, "to");
      return `➡️ Forwarded to ${Array.isArray(to) ? to.join(", ") : "the requested recipients"}.`;
    }

    case "email.unsubscribe": {
      const method = str(r, "method");
      if (method === "one_click") return "🔕 Unsubscribed (one-click).";
      if (method === "mailto") return "🔕 Unsubscribe request sent.";
      if (method === "link_presented") {
        return (
          `This list only offers a link, not one-click or email unsubscribe — I won't fetch ` +
          `it myself:\n${str(r, "url") ?? ""}`
        );
      }
      return "No unsubscribe method found on this message.";
    }
```

**Verify:** `bun run typecheck` — clean.

---

## Step 16 — Prove there is no delete tool, and never will be

**File:** `tests/unit/no-hard-delete-tool.test.ts` **(create)**

**What this file is for.** "Never expose a hard-delete tool" is a rule about the future as much as the present — the risk is someone adding `email.delete_permanently` two years from now without remembering why it was never there. A test that fails the moment such a name appears is worth more than a comment.

```ts
import { describe, expect, test } from "bun:test";
import { TOOL_NAMES, isToolName } from "../../convex/lib/tools/catalog";

describe("tool registry — no hard-delete tool, ever", () => {
  test("email.delete_permanently does not exist", () => {
    expect(TOOL_NAMES).not.toContain("email.delete_permanently");
    expect(isToolName("email.delete_permanently")).toBe(false);
  });

  test("no tool name anywhere contains the word delete", () => {
    // A broader net than the one exact name above — trash is fine, delete
    // never is, whatever it gets called.
    const suspicious = TOOL_NAMES.filter((name) => name.toLowerCase().includes("delete"));
    expect(suspicious).toEqual([]);
  });

  test("email.trash exists — the reversible alternative this project uses instead", () => {
    expect(TOOL_NAMES).toContain("email.trash");
  });
});
```

**Verify:** `bun test tests/unit/no-hard-delete-tool.test.ts` — all 3 pass.

---

## Step 17 — Adversarial: a duplicate push is exactly one row

**File:** `tests/adversarial/webhook-idempotency.test.ts` **(create)**

**What this file is for.** Appendix C's #8 (a duplicate Pub/Sub delivery with an identical payload must produce exactly one `emailMessages` row) and #21 (the same message arriving via both push and the safety-net sweep must still be exactly one row). The second half of each — the actual database check-then-insert — needs a real Convex transaction and cannot run under `bun test`, which has no Convex runtime; this file proves the pure parsing layer is deterministic and safe against a replayed or malformed payload, and the **Verify** step below covers the transactional half by hand against dev, the same pattern Phase 4's doc already established for anything a unit test structurally cannot reach.

```ts
import { describe, expect, test } from "bun:test";
import { parsePubSubEnvelope } from "../../convex/connectors/gmail/pubsub";

function encodeEnvelope(emailAddress: string, historyId: string, messageId: string): string {
  const data = btoa(JSON.stringify({ emailAddress, historyId }));
  return JSON.stringify({
    message: { data, messageId },
    subscription: "projects/x/subscriptions/gmail-push-sub",
  });
}

describe("Pub/Sub envelope parsing — adversarial #8, #21", () => {
  test("parsing the identical payload twice yields identical results", () => {
    const raw = encodeEnvelope("me@example.com", "12345", "msg-1");
    expect(parsePubSubEnvelope(raw)).toEqual(parsePubSubEnvelope(raw));
  });

  test("messageId is what idempotency keys on — a genuine Pub/Sub redelivery of the SAME underlying change carries the SAME messageId", () => {
    const first = encodeEnvelope("me@example.com", "12345", "msg-1");
    const redelivered = encodeEnvelope("me@example.com", "12345", "msg-1");
    expect(parsePubSubEnvelope(first)?.messageId).toBe(parsePubSubEnvelope(redelivered)?.messageId);
  });

  test("two DIFFERENT pushes never collide on messageId", () => {
    const a = encodeEnvelope("me@example.com", "12345", "msg-1");
    const b = encodeEnvelope("me@example.com", "12346", "msg-2");
    expect(parsePubSubEnvelope(a)?.messageId).not.toBe(parsePubSubEnvelope(b)?.messageId);
  });

  test("a malformed envelope (no message.data) parses to null, not a throw", () => {
    expect(parsePubSubEnvelope(JSON.stringify({ subscription: "x" }))).toBeNull();
  });

  test("garbage JSON parses to null, not a throw", () => {
    expect(parsePubSubEnvelope("not json")).toBeNull();
  });
});
```

**Verify:**
1. `bun test tests/adversarial/webhook-idempotency.test.ts` — all 5 pass.
2. Against dev, the transactional half `bun test` cannot reach: capture one real push body (log it once from inside the `/webhooks/gmail` handler, then remove the log line), then `curl` it at `/webhooks/gmail` **twice** with a valid signed JWT — or more simply, call `bunx convex run model/webhookEvents:record '{"source":"gmail_pubsub","externalId":"test-dup-1","payload":{}}'` twice in a row and confirm the second call returns `isNew: false` while the Convex dashboard's `webhookEvents` table shows exactly one row with `externalId: "test-dup-1"`.
3. For #21: manually run `internal.gmail.syncFromHistory` and `internal.gmail.syncAll` back to back against the same account with unsynced mail waiting — the `emailMessages` table should show exactly one row per message afterward, proven by the existing `by_account_provider_id` uniqueness check inside `emailMessages.upsert` (Phase 3), exercised here under a new caller for the first time.

---

## Done when

This phase's exit criterion **is** the source plan's own MVP Definition of Done, reproduced verbatim:

- [ ] All three Gmail accounts connected, each independently authorized
- [ ] A new important email from **any** account triggers a Telegram alert within ~60 seconds
- [ ] **A message that lands in SPAM triggers the alert, badged as such**
- [ ] The alert names the source mailbox
- [ ] `[ TL;DR ]` and `[ Full message ]` both work
- [ ] `[ Draft a reply ]` produces a draft using thread + project context
- [ ] `[ Send ]` sends from the correct account, in the correct thread, only after explicit approval
- [ ] A watch expiring or a token being revoked produces a Telegram alert, not silence
- [ ] Every action has an `auditLogs` row
- [ ] The scheduled morning digest arrives
- [ ] The full adversarial suite (Appendix C) passes
- [ ] Running cost: $0/month

```bash
git add -A && git commit -m "Phase 8: Gmail push via Pub/Sub, history-based reconciliation, safe mailbox actions"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/connectors/gmail/pubsub.ts` | Verifies the Pub/Sub push's OIDC JWT against Google's JWKS; parses the envelope. |
| `convex/model/webhookEvents.ts` | Check-then-insert idempotency on `externalId`, inside one transaction. |
| `convex/model/syncCursors.ts` | Per-account `lastHistoryId` and consecutive-failure bookkeeping. |
| `convex/http.ts` | `POST /webhooks/gmail` — verify, dedup, acknowledge in milliseconds, hand off to a scheduled action. |
| `convex/connectors/gmail/client.ts` | `watch`, `historyList`, `modifyMessage`, `trashMessage`, `sendRaw` — five thin Gmail REST wrappers. |
| `convex/connectors/gmail/oauth.ts` | `GMAIL_MODIFY_SCOPES` — the scope every mailbox action needs. |
| `convex/model/connectedAccounts.ts` | `recordWatch` — stores what `users.watch` returned. |
| `convex/model/emailMessages.ts` | `setLabels` — keeps the cached labels honest after a live modify/trash call. |
| `convex/gmail.ts` | Push-driven incremental sync with a full-resync fallback, watch registration and renewal, and the nine action executors that actually touch Gmail. |
| `convex/crons.ts` | Daily watch renewal; a 6-hourly safety net replaces Phase 3's frequent polling. |
| `convex/lib/config.ts` | Three new required Pub/Sub variables, so `/health` catches a missing one before Telegram goes silent. |
| `convex/lib/prompts/assistant.ts` | `SCOPE` states plainly that email is no longer read-only, and that the new actions still require approval. |
| `convex/lib/tools/catalog.ts` | Nine new tool schemas — the four non-consequential ones, the five that route through the approval gate. |
| `convex/tools/router.ts` | Nine new dispatch cases, one shared ownership-check helper. |
| `convex/lib/tools/outcomes.ts` | Nine new renderers — what the user actually reads after each action. |
| `tests/unit/no-hard-delete-tool.test.ts` | Structurally guarantees the registry has no delete tool, now or ever. |
| `tests/adversarial/webhook-idempotency.test.ts` | Adversarial #8 and #21 — a duplicate or double-sourced delivery is exactly one row. |

---

## Next

**Stop here and use the assistant for two weeks before building anything else.** The source plan says this explicitly, and it is not a formality: two weeks of real mail, real pushes, and real approval taps will surface what actually needs building next — Phase 9 (voice notes), Phase 10 (Calendar, skipped for now), or Phase 11 (Drive context) all assume a foundation that only real use, not more code, can validate.
