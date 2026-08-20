# Phase 11 — Drive as context

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** `docs/personal-ai-assistant-build-plan-v3-convex.md` → *Phase 11 — Google Drive as context*
- **Prerequisite:** Gmail connect already works in this codebase — `/connect`, `convex/connectors/gmail/`, `convex/model/oauthStates.ts`, `convex/tools/router.ts`'s `account.connect_link` case. Drafting and sending (source Phase 6) has **not** landed yet — `email.create_draft`/`email.update` don't exist as tools. That's fine: this phase only needs to *find* a document, not attach one. The schema already carries `drafts.attachmentFileIds` (comment: `// Phase 11, in payloadHash`) waiting for that day.

---

## What you'll have at the end

"Find my latest CV" returns a short, dated list of Drive candidates — never a single file the model picked for you. Drive access is its own `connectedAccounts` row (`provider: "google_drive"`), authorized and revocable independently of any Gmail connection on the same address. There is no tool anywhere in the catalog that attaches a file to anything — that capability doesn't exist yet, on purpose, and won't until drafting (Phase 6) lands and can put the chosen file id inside an approval hash.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 1 | `convex/connectors/drive/oauth.ts` | new | Google OAuth for Drive — mirrors `gmail/oauth.ts`, scope swapped to `drive.readonly` |
| 2 | `convex/connectors/drive/client.ts` | new | Thin Drive REST client: search, metadata, text-extraction with MIME gating |
| 3 | `tests/unit/drive-client.test.ts` | new | Pure tests for the MIME-type gate and the query-building helper |
| 4 | `convex/model/oauthStates.ts` | edit | `issue`/`peek`/`consume` carry a `provider` (`"gmail"` \| `"google_drive"`) through the handshake |
| 5 | `convex/http.ts` | edit | `/oauth/google/start` and `/oauth/google/callback` branch on that provider |
| 6 | `convex/drive.ts` | new | `completeConnect` (mirrors `gmail.ts`) and `accessTokenFor` — no sync loop, Drive is queried live |
| 7 | `convex/lib/tools/catalog.ts` | edit | `drive.search_files`, `drive.get_metadata`, `drive.read_content`; `account.connect_link` gains `provider` |
| 8 | `convex/tools/router.ts` | edit | Dispatches the three new tools; `resolveAccountIds` learns to filter by provider |
| 9 | `convex/lib/tools/outcomes.ts` | edit | Renders Drive results, and the connect-link confirmation for either provider |
| 10 | `convex/gmail.ts` | edit | `syncAll` must skip Drive rows — one-line fix, explained below |
| 11 | `convex/assistant.ts` | edit | `/connect drive`, and the same Drive-must-not-sync-as-Gmail fix in `/sync` and `/accounts` |
| 12 | `convex/lib/prompts/assistant.ts` | edit | Remove Drive from `SCOPE`'s denial list; state what it actually is |
| 13 | `tests/unit/assistant-prompt.test.ts` | edit | Match the new `SCOPE` wording |

**Why steps 4–6 exist even though they weren't in the original ask.** The design decision — Drive is a *second, independently authorized* `connectedAccounts` row — only works if the OAuth handshake itself knows which connector to hand the code to. `oauthStates` already has a `provider` column (currently always `"google"` and never read back); this phase is what finally reads it. No schema change, no new HTTP route, no second OAuth client — exactly the "no new OAuth plumbing" the design calls for, just two existing routes learning to branch.

---

## Step 1 — Drive OAuth

**File:** `convex/connectors/drive/oauth.ts` **(create)**

**What this file is for.** The exact shape of `connectors/gmail/oauth.ts`, scope swapped. It reuses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — the same OAuth client Phase 3 already created. Only the Drive API needs enabling in Google Cloud Console (the provisioning table in the build plan already lists this at Phase 11); there is no second client, no second consent screen, no new redirect URI to register.

```ts
// Google OAuth 2.0 for Drive, over plain fetch. No googleapis SDK — same
// §0.2 compute argument as connectors/gmail/oauth.ts.
//
// Reuses the SAME GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI as Gmail's connector.
// That is deliberate: Drive is a second, independently authorized
// connectedAccounts row (provider: "google_drive"), not a widened Gmail
// scope grant — but it is still the same Google Cloud OAuth client, so no
// new client or redirect URI needs registering for this phase.

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Read-only, and nothing else. Never request drive.file or the bare drive
 * scope (full read/write) — there is a test asserting this list, same
 * discipline as GMAIL_READONLY_SCOPES.
 */
export const DRIVE_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export class TokenRevoked extends Error {
  constructor(detail: string) {
    super(`refresh token rejected: ${detail.slice(0, 200)}`);
    this.name = "TokenRevoked";
  }
}

function requireClient(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must all be set",
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
    scope: DRIVE_READONLY_SCOPES.join(" "),
    state,
    // Same reasoning as Gmail's connector: without both of these, a second
    // authorization of an already-granted identity returns an access token
    // only, and the account silently cannot refresh.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
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
    if (text.includes("invalid_grant")) throw new TokenRevoked(text);
    throw new Error(`google token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!json.access_token) throw new Error("google returned no access_token");

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in ?? 3600,
    scopes: json.scope ? json.scope.split(" ") : [],
  };
}
```

**Verify:** `bun run typecheck` passes.

---

## Step 2 — Drive client

**File:** `convex/connectors/drive/client.ts` **(create)**

**What this file is for.** The only place that knows Drive's wire format. Two things are not obvious from the API surface and matter a lot in practice:

1. **`q` is a query language, not a search box.** Gmail's `listMessages` could take a raw string like `newer_than:2d` straight from the caller. Drive's `q` needs structured syntax (`fullText contains 'CV'`) — handing it a bare model-supplied keyword produces zero results with no error, the worst kind of silent failure. `searchFiles` builds the structured query itself so the tool-facing argument can stay a plain keyword.
2. **Google Docs/Sheets/Slides have no bytes to download.** `alt=media` — the normal "give me the file" request — 403s on them; they must be *exported* to a plain format instead. Everything else that isn't on the extractable allow-list is refused before any request is made, never handed to the model half-garbled.

```ts
// A thin Drive REST client. No "use node", no SDK — the same §0.2 compute
// argument as connectors/gmail/client.ts.

const BASE = "https://www.googleapis.com/drive/v3";

export class DriveApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`drive ${status}: ${body.slice(0, 300)}`);
    this.name = "DriveApiError";
  }
  /** 401/403 means the access token is stale or the grant is gone. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

async function driveFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new DriveApiError(res.status, await res.text());
  return (await res.json()) as T;
}

/**
 * Confirms which Google account was actually authorized — the same role
 * Gmail's getProfile plays in connectors/gmail/client.ts. drive.readonly
 * covers this endpoint, so no extra scope is needed.
 */
export async function getAbout(accessToken: string): Promise<{ emailAddress: string }> {
  const about = await driveFetch<{ user?: { emailAddress?: string } }>(
    accessToken,
    "/about?fields=user(emailAddress)",
  );
  if (!about.user?.emailAddress) {
    throw new DriveApiError(500, "no user.emailAddress in /about response");
  }
  return { emailAddress: about.user.emailAddress };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string; // RFC 3339
  size?: string; // bytes, as a STRING — Drive's own quirk, not ours
  webViewLink?: string;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

/**
 * Accepts a plain keyword or phrase — what a model will actually send — and
 * turns it into Drive's query language. A caller that already knows Drive
 * syntax (it contains an operator like `contains` or `=`) is passed through
 * unmodified, so this never mangles a deliberately precise query.
 */
export function buildDriveQuery(rawQuery: string): string {
  const looksStructured = /\b(contains|=|!=|\band\b|\bor\b|\bnot\b|in\s+parents)\b/i.test(
    rawQuery,
  );
  if (looksStructured) return rawQuery;

  const escaped = rawQuery.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `fullText contains '${escaped}' or name contains '${escaped}'`;
}

/**
 * `trashed = false` is added unless the caller's query already mentions
 * trash — Drive does NOT exclude trashed files by default the way Gmail's
 * listMessages excludes nothing (Phase 3's includeSpamTrash principle runs
 * the other direction here: a search for "my latest CV" should never
 * surface a file the user threw away).
 */
export async function searchFiles(
  accessToken: string,
  options: { query: string; pageSize: number },
): Promise<{ files: DriveFile[] }> {
  const built = buildDriveQuery(options.query);
  const q = built.includes("trashed") ? built : `(${built}) and trashed = false`;

  const params = new URLSearchParams({
    q,
    orderBy: "modifiedTime desc",
    pageSize: String(options.pageSize),
    fields: `files(${FILE_FIELDS})`,
  });
  return await driveFetch(accessToken, `/files?${params.toString()}`);
}

export async function getMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  return await driveFetch(accessToken, `/files/${fileId}?fields=${FILE_FIELDS}`);
}

/** Google-native types have no downloadable bytes — they must be exported to
 *  a plain format. The map value is what we ask Drive to convert TO. */
const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Ordinary files whose bytes ARE plain text — safe to hand back verbatim. */
const DIRECTLY_READABLE = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

export function isTextExtractable(mimeType: string): boolean {
  return mimeType in GOOGLE_NATIVE_EXPORT || DIRECTLY_READABLE.has(mimeType);
}

export class UnsupportedMimeType extends Error {
  constructor(readonly mimeType: string) {
    super(`"${mimeType}" has no text-extraction path — search or get_metadata only`);
    this.name = "UnsupportedMimeType";
  }
}

/**
 * Reads a file's content as text. The MIME type is checked BEFORE any
 * network request — a PDF, image, or other binary type never reaches
 * fetch, so there is no partial download and no chance of garbled bytes
 * reaching the model.
 */
export async function readContent(
  accessToken: string,
  fileId: string,
  mimeType: string,
): Promise<string> {
  const exportMimeType = GOOGLE_NATIVE_EXPORT[mimeType];
  if (exportMimeType) {
    const res = await fetch(
      `${BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new DriveApiError(res.status, await res.text());
    return await res.text();
  }

  if (!DIRECTLY_READABLE.has(mimeType)) {
    throw new UnsupportedMimeType(mimeType);
  }

  const res = await fetch(`${BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new DriveApiError(res.status, await res.text());
  return await res.text();
}
```

**Verify:** `bun run typecheck` passes.

---

## Step 3 — MIME-gating tests

**File:** `tests/unit/drive-client.test.ts` **(create)**

**What this file is for.** `client.ts` makes network calls, but the MIME gate and the query builder are pure decisions inside it — testable with no token and no fetch, in the same spirit as `resolve.ts`'s tests in Phase 1. The point of the test isn't just "returns true/false" — it's proving a refused type never reaches `fetch` at all.

```ts
import { describe, expect, mock, test } from "bun:test";
import {
  buildDriveQuery,
  isTextExtractable,
  readContent,
  UnsupportedMimeType,
} from "../../convex/connectors/drive/client";

describe("isTextExtractable", () => {
  test("accepts plain text and Google-native document types", () => {
    expect(isTextExtractable("text/plain")).toBe(true);
    expect(isTextExtractable("text/markdown")).toBe(true);
    expect(isTextExtractable("application/json")).toBe(true);
    expect(isTextExtractable("application/vnd.google-apps.document")).toBe(true);
    expect(isTextExtractable("application/vnd.google-apps.spreadsheet")).toBe(true);
  });

  test("refuses binary, image, and folder types", () => {
    expect(isTextExtractable("application/pdf")).toBe(false);
    expect(isTextExtractable("image/png")).toBe(false);
    expect(isTextExtractable("application/vnd.google-apps.folder")).toBe(false);
  });
});

describe("readContent — MIME gating", () => {
  test("refuses a non-extractable type WITHOUT making a network call", async () => {
    const fetchSpy = mock(() => {
      throw new Error("fetch must not be called for a refused MIME type");
    });
    const original = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;

    try {
      await expect(readContent("token", "file123", "application/pdf")).rejects.toThrow(
        UnsupportedMimeType,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = original;
    }
  });

  test("reads a directly-downloadable type via alt=media", async () => {
    const original = global.fetch;
    global.fetch = mock(async () => new Response("hello world")) as unknown as typeof fetch;

    try {
      const text = await readContent("token", "file123", "text/plain");
      expect(text).toBe("hello world");
    } finally {
      global.fetch = original;
    }
  });

  test("exports a Google Doc to text/plain instead of downloading raw bytes", async () => {
    const original = global.fetch;
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response("doc contents");
    }) as unknown as typeof fetch;

    try {
      const text = await readContent("token", "file123", "application/vnd.google-apps.document");
      expect(calledUrl).toContain("/export?mimeType=text%2Fplain");
      expect(text).toBe("doc contents");
    } finally {
      global.fetch = original;
    }
  });
});

describe("buildDriveQuery", () => {
  test("wraps a plain keyword into fullText/name search", () => {
    expect(buildDriveQuery("CV")).toBe("fullText contains 'CV' or name contains 'CV'");
  });

  test("escapes a single quote in the keyword", () => {
    expect(buildDriveQuery("Paul's contract")).toBe(
      "fullText contains 'Paul\\'s contract' or name contains 'Paul\\'s contract'",
    );
  });

  test("passes a caller-supplied structured query through unmodified", () => {
    const structured = "name contains 'CV' and trashed = false";
    expect(buildDriveQuery(structured)).toBe(structured);
  });
});
```

**Verify:** `bun test tests/unit/drive-client.test.ts` — all passing, no network, no token.

---

## Step 4 — Carry `provider` through the OAuth handshake

**File:** `convex/model/oauthStates.ts` **(edit)**

**What this does.** `oauthStates` already has a `provider` column — `issue` has always written `"google"` into it, and nothing has ever read it back. That's what makes this a genuinely small edit: the column exists, the schema needs no change. From this step on it carries `"gmail"` or `"google_drive"`, and `peek`/`consume` hand it back so `http.ts` knows which connector minted the link.

Change the `issue` mutation's args and insert:

```ts
export const issue = internalMutation({
  args: {
    userId: v.id("users"),
    label: v.string(),
    /** "gmail" (default) | "google_drive". Determines which OAuth module
     *  and which completeConnect action the callback hands off to. */
    provider: v.optional(v.string()),
    reconnectAccountId: v.optional(v.id("connectedAccounts")),
  },
  handler: async (ctx, args) => {
    const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

    await ctx.db.insert("oauthStates", {
      nonce,
      userId: args.userId,
      provider: args.provider ?? "gmail",
      label: args.label,
      expiresAt: Date.now() + TTL_MS,
      reconnectAccountId: args.reconnectAccountId,
    });

    return { nonce, expiresAt: Date.now() + TTL_MS };
  },
});
```

Change `peek`'s return to include it:

```ts
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      await ctx.db.delete("oauthStates", row._id);
      return null;
    }
    return { label: row.label, provider: row.provider };
```

Change `consume`'s return to include it:

```ts
    return {
      userId: row.userId,
      label: row.label,
      provider: row.provider,
      reconnectAccountId: row.reconnectAccountId,
    };
```

**Verify:** `bun run typecheck` passes. `bunx convex dev` pushes with no schema diff — this is a pure logic change, the column already existed.

---

## Step 5 — Branch the OAuth routes on provider

**File:** `convex/http.ts` **(edit)**

**What this does.** The two existing routes are the entire "OAuth plumbing" this design ever needed — they just didn't know a second connector existed yet. Both keep their path (`/oauth/google/...`) and their nonce-is-the-authorization contract unchanged; only the handler bodies branch.

Change the import at the top:

```ts
import { authorizeUrl as gmailAuthorizeUrl } from "./connectors/gmail/oauth";
import { authorizeUrl as driveAuthorizeUrl } from "./connectors/drive/oauth";
```

In `/oauth/google/start`, replace the redirect with:

```ts
    const state = await ctx.runMutation(internal.model.oauthStates.peek, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Send /connect again.",
      );
    }

    const authorize = state.provider === "google_drive" ? driveAuthorizeUrl : gmailAuthorizeUrl;

    return new Response(null, {
      status: 302,
      headers: { Location: authorize(nonce) },
    });
```

In `/oauth/google/callback`, replace the single `scheduler.runAfter` call with a branch:

```ts
    const state = await ctx.runMutation(internal.model.oauthStates.consume, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Send /connect again.",
      );
    }

    const user = await ctx.runQuery(internal.model.users.get, { userId: state.userId });
    if (!user) return page(500, "Unknown user", "Could not identify who started this.");

    // Do the exchange in the background either way: Google's callback should
    // not wait on a token round trip plus (for Gmail) a first sync.
    if (state.provider === "google_drive") {
      await ctx.scheduler.runAfter(0, internal.drive.completeConnect, {
        code,
        userId: state.userId,
        label: state.label,
        telegramId: user.telegramId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.gmail.completeConnect, {
        code,
        userId: state.userId,
        label: state.label,
        telegramId: user.telegramId,
      });
    }

    return page(
      200,
      "Connected",
      "You can close this tab — the confirmation is in Telegram.",
    );
```

**Verify:** `bunx convex dev` pushes with no error. `/connect recruiting` (plain Gmail) still ends in the same Telegram confirmation as before — this is the regression check that matters most, since both routes now share logic with a path that didn't exist yesterday.

---

## Step 6 — Complete the Drive handshake

**File:** `convex/drive.ts` **(create)**

**What this file is for.** The Drive equivalent of `gmail.ts`'s top section — `completeConnect` and the decrypt-and-refresh helper. One deliberate difference from Gmail: **no sync loop.** Drive is never polled or mirrored locally; every `drive.*` tool call hits the API live, on demand, so there is nothing to warm up after connecting.

```ts
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { seal, open } from "./security/crypto";
import { exchangeCode, refreshAccessToken, DRIVE_READONLY_SCOPES } from "./connectors/drive/oauth";
import { getAbout } from "./connectors/drive/client";
import { sendMessage } from "./channels/telegram";

/**
 * Finish the Drive OAuth handshake: swap the code for tokens, confirm which
 * Google account was actually authorized, encrypt the refresh token, store
 * the account as its OWN connectedAccounts row (provider: "google_drive") —
 * never merged into an existing Gmail row for the same address, even when
 * they're the same inbox. Revoking one must never touch the other.
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
        "Google returned no refresh token. Remove this app at " +
          "myaccount.google.com/permissions and connect again.",
      );
    }

    const about = await getAbout(tokens.accessToken);
    const sealed = await seal(tokens.refreshToken);

    const result = await ctx.runMutation(internal.model.connectedAccounts.upsert, {
      userId: args.userId,
      provider: "google_drive",
      accountEmail: about.emailAddress,
      displayName: about.emailAddress,
      label: args.label,
      encryptedCredentials: sealed.ciphertext,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      scopesGranted: tokens.scopes.length ? tokens.scopes : [...DRIVE_READONLY_SCOPES],
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "user",
      action: "account.connect",
      targetType: "connectedAccounts",
      targetId: result.accountId,
      args: { provider: "google_drive", label: args.label, email: about.emailAddress },
      result: "ok",
    });

    await sendMessage(
      args.telegramId,
      `✅ Connected Drive (${about.emailAddress}) as "${args.label}".\n` +
        `Read-only — I can find and read documents, never create, share, or delete.`,
    );

    return { accountEmail: about.emailAddress };
  },
});

/**
 * Decrypt the refresh token and mint an access token. Same decrypt-only-
 * here-only-at-the-moment-of-use discipline as gmail.ts's accessTokenFor —
 * the plaintext refresh token lives only inside this function's frame.
 */
export async function accessTokenFor(
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
```

**Verify:** `bun run typecheck` passes. `bunx convex dev` picks up the new file with no error.

---

## Step 7 — Three new tools, and `provider` on `account.connect_link`

**File:** `convex/lib/tools/catalog.ts` **(edit)**

**What this does.** Adds the three read-only Drive tools, and gives `account.connect_link` a second, optional argument. Every field keeps the `.describe()` discipline the top-of-file comment insists on — an undescribed optional enum is exactly what silently produced the wrong `priority` type before this rule existed.

Add a preprocessing enum for the connect-link provider, near `EMAIL_LABEL`:

```ts
/**
 * "gmail" is the default and needs no argument at all — this only matters
 * the moment the user says "connect my Drive too". Accepts "drive" as a
 * spoken shorthand for "google_drive".
 */
const CONNECT_PROVIDER = z
  .preprocess((value) => {
    const normalized = normalizeEnum(value);
    return normalized === "DRIVE" ? "GOOGLE_DRIVE" : normalized;
  }, z.enum(["GMAIL", "GOOGLE_DRIVE"]))
  .optional()
  .describe(
    '"gmail" (default) or "google_drive"/"drive" — Drive is a SEPARATE ' +
      "authorization, even for an already-connected Gmail address",
  );
```

Change `account.connect_link` in `TOOL_SCHEMAS`:

```ts
  "account.connect_link": z.object({
    label: z
      .string()
      .min(1)
      .optional()
      .describe('short tag for this mailbox, e.g. "personal" or "recruiting" — default "personal"'),
    provider: CONNECT_PROVIDER,
  }),
```

Add the three Drive tools to `TOOL_SCHEMAS`, right after `email.get_message`:

```ts
  "drive.search_files": z.object({
    query: z
      .string()
      .min(1)
      .describe("keyword or phrase to search for in the file name and content, e.g. \"CV\""),
    accountLabel: z.string().optional().describe("connected Drive account label; omit for the default"),
    limit: z.number().int().min(1).max(20).optional().describe("default 10"),
  }),
  "drive.get_metadata": z.object({
    fileId: z.string().min(1).describe("id from a drive.search_files result"),
    accountLabel: z.string().optional(),
  }),
  "drive.read_content": z.object({
    fileId: z.string().min(1).describe("id from a drive.search_files result"),
    accountLabel: z.string().optional(),
  }),
```

Change `account.connect_link`'s entry in `TOOL_META`:

```ts
  "account.connect_link": {
    description:
      "Get a one-time link to connect a Gmail mailbox or a Drive account " +
      "(set provider). Use this whenever the user asks to connect, add, or " +
      "link an email or Drive account — do not just explain in prose that " +
      "you cannot access it.",
    consequential: false,
    requiresAccountId: false,
  },
```

Add the three Drive tools to `TOOL_META`, right after `email.get_message`:

```ts
  "drive.search_files": {
    description:
      "Search Drive by keyword. Returns candidates with names and modified " +
      "dates — NEVER attaches or picks one for the user; that decision is " +
      "always theirs.",
    consequential: false,
    requiresAccountId: true,
  },
  "drive.get_metadata": {
    description: "Full metadata (name, type, modified date, link) for one Drive file by id.",
    consequential: false,
    requiresAccountId: true,
  },
  "drive.read_content": {
    description:
      "Read a Drive file's text content by id. Text-extractable types only " +
      "(Google Docs/Sheets, plain text) — refuses PDFs, images, and other " +
      "binary types rather than garbling them.",
    consequential: false,
    requiresAccountId: true,
  },
```

**Verify:** `bun run typecheck` passes. `bun test` still passes — this file has no dedicated test suite, but `assistant-prompt.test.ts` (Step 13) exercises `describeCatalog()` and will fail loudly on a malformed schema.

---

## Step 8 — Wire the tools into the router

**File:** `convex/tools/router.ts` **(edit)**

**What this does.** Three new `dispatch` cases, the `account.connect_link` case extended with `provider`, and one correctness fix: `resolveAccountIds` currently has no idea Gmail and Drive rows can coexist under the same user — it will happily hand a Drive account's id to an `email.*` query (harmless, since `emailMessages` has no rows for it) or, worse, hand a Gmail account's id to a Drive tool. This step gives it a `provider` filter with a backward-compatible default.

Add imports at the top:

```ts
import { searchFiles, getMetadata, readContent, UnsupportedMimeType, type DriveFile } from "../connectors/drive/client";
import { accessTokenFor as driveAccessTokenFor } from "../drive";
import { TokenRevoked as DriveTokenRevoked } from "../connectors/drive/oauth";
```

Change `resolveAccountIds`'s signature and body:

```ts
async function resolveAccountIds(
  ctx: ActionCtx,
  userId: Id<"users">,
  label: unknown,
  provider: string = "gmail",
): Promise<Id<"connectedAccounts">[]> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
    userId,
  });
  const active = accounts.filter((acc) => acc.status === "ACTIVE" && acc.provider === provider);
  if (typeof label !== "string" || label.length === 0) return active.map((a) => a._id);

  const matched = active.filter((a) => a.label.toLowerCase() === label.toLowerCase());
  return matched.map((a) => a._id);
}
```

The three existing `email.*` call sites (`email.list_recent`, `email.search`, `email.get_message` — via its own account lookup) need **no change**: `provider` defaults to `"gmail"`, which is exactly what they were implicitly assuming all along.

Add two small helpers near `resolveAccountIds`:

```ts
async function resolveDriveAccountId(
  ctx: ActionCtx,
  userId: Id<"users">,
  label: unknown,
): Promise<Id<"connectedAccounts"> | null> {
  const ids = await resolveAccountIds(ctx, userId, label, "google_drive");
  return ids[0] ?? null;
}

/**
 * Same decrypt-refresh discipline as Gmail's, plus the same weekly
 * Testing-mode-expiry handling: a rejected refresh token marks the account
 * NEEDS_REAUTH and returns a typed result instead of throwing a raw fetch
 * error into the model's face.
 */
async function driveAccessToken(
  ctx: ActionCtx,
  accountId: Id<"connectedAccounts">,
): Promise<{ accessToken: string } | { needsReauth: true }> {
  try {
    return { accessToken: await driveAccessTokenFor(ctx, accountId) };
  } catch (error) {
    if (error instanceof DriveTokenRevoked) {
      await ctx.runMutation(internal.model.connectedAccounts.markNeedsReauth, {
        accountId,
        reason: "drive refresh token rejected",
      });
      return { needsReauth: true };
    }
    throw error;
  }
}

function summarizeDriveFile(timezone: string) {
  return (file: DriveFile) => ({
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedAt: formatInstant(Date.parse(file.modifiedTime), timezone),
    link: file.webViewLink,
  });
}
```

Change the `account.connect_link` case in `dispatch`:

```ts
    case "account.connect_link": {
      const label = ((a.label as string | undefined) ?? "personal")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");
      const provider = (a.provider as string | undefined) === "GOOGLE_DRIVE" ? "google_drive" : "gmail";
      const siteUrl = process.env.CONVEX_SITE_URL;
      if (!siteUrl) throw new Error("CONVEX_SITE_URL is not set on this deployment");

      const { nonce } = await ctx.runMutation(internal.model.oauthStates.issue, {
        userId,
        label: label || "personal",
        provider,
      });
      return {
        label: label || "personal",
        provider,
        url: `${siteUrl}/oauth/google/start?state=${nonce}`,
      };
    }
```

Add three cases, right after `email.get_message`:

```ts
    case "drive.search_files": {
      const accountId = await resolveDriveAccountId(ctx, userId, a.accountLabel);
      if (!accountId) return { connected: false };

      const token = await driveAccessToken(ctx, accountId);
      if ("needsReauth" in token) return { connected: true, needsReauth: true };

      const { files } = await searchFiles(token.accessToken, {
        query: a.query as string,
        pageSize: (a.limit as number | undefined) ?? 10,
      });
      return { connected: true, files: files.map(summarizeDriveFile(timezone)) };
    }

    case "drive.get_metadata": {
      const accountId = await resolveDriveAccountId(ctx, userId, a.accountLabel);
      if (!accountId) return { connected: false };

      const token = await driveAccessToken(ctx, accountId);
      if ("needsReauth" in token) return { connected: true, needsReauth: true };

      const file = await getMetadata(token.accessToken, a.fileId as string);
      return { connected: true, file: summarizeDriveFile(timezone)(file) };
    }

    case "drive.read_content": {
      const accountId = await resolveDriveAccountId(ctx, userId, a.accountLabel);
      if (!accountId) return { connected: false };

      const token = await driveAccessToken(ctx, accountId);
      if ("needsReauth" in token) return { connected: true, needsReauth: true };

      const file = await getMetadata(token.accessToken, a.fileId as string);
      try {
        const text = await readContent(token.accessToken, a.fileId as string, file.mimeType);
        return { connected: true, name: file.name, mimeType: file.mimeType, text: text.slice(0, 8000) };
      } catch (error) {
        if (error instanceof UnsupportedMimeType) {
          return { connected: true, unsupported: true, mimeType: file.mimeType, name: file.name };
        }
        throw error;
      }
    }
```

**Note what is absent.** There is no `drive.attach_to_draft`, no argument on any tool that takes a Drive file id and puts it anywhere consequential. `drive.read_content`'s only effect is returning text to the model as data — the same category as `email.get_message`, not the same category as anything that changes what gets sent. That's not an oversight; it's the whole point of this phase.

**Verify:** `bun run typecheck` passes.

---

## Step 9 — Render the Drive outcomes

**File:** `convex/lib/tools/outcomes.ts` **(edit)**

**What this does.** Turns the three new tool results into text, and makes the `account.connect_link` confirmation say which kind of account it's for.

Change the `account.connect_link` case in `renderOne`:

```ts
    case "account.connect_link": {
      const provider = str(r, "provider");
      const kind = provider === "google_drive" ? "Drive account" : "Gmail mailbox";
      return [
        `Connect a ${kind} as "${str(r, "label")}":`,
        String(field(r, "url")),
        provider === "google_drive"
          ? "Read-only — search and read documents only. The link works once and expires in 10 minutes."
          : "Read-only. The link works once and expires in 10 minutes.",
      ].join("\n");
    }
```

Add a renderer function near `renderEmailList`:

```ts
function renderDriveFileList(r: unknown): string {
  if (field(r, "connected") === false) {
    return "No Drive account connected. I can send you a link to connect one — just ask.";
  }
  if (field(r, "needsReauth") === true) {
    return "⚠️ Drive access needs reconnecting — the refresh token was rejected. Ask me to connect Drive again to fix it.";
  }
  const rows = field(r, "files");
  const files = Array.isArray(rows) ? rows : [];
  if (files.length === 0) return "No matching files in Drive.";

  return files
    .map(
      (f) =>
        `• [${str(f, "fileId")}] ${str(f, "name") ?? "(untitled)"} — ${
          str(f, "mimeType") ?? "?"
        }, modified ${str(f, "modifiedAt") ?? "?"}`,
    )
    .join("\n");
}
```

Add three cases to the `switch` in `renderOne`, right after `email.get_message`:

```ts
    case "drive.search_files":
      return renderDriveFileList(r);

    case "drive.get_metadata": {
      if (field(r, "connected") === false) return "No Drive account connected.";
      if (field(r, "needsReauth") === true) return "⚠️ Drive access needs reconnecting.";
      const file = field(r, "file");
      return [
        str(file, "name") ?? "(untitled)",
        `  type: ${str(file, "mimeType") ?? "?"}`,
        `  modified: ${str(file, "modifiedAt") ?? "?"}`,
        field(file, "link") ? `  link: ${String(field(file, "link"))}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "drive.read_content": {
      if (field(r, "connected") === false) return "No Drive account connected.";
      if (field(r, "needsReauth") === true) return "⚠️ Drive access needs reconnecting.";
      if (field(r, "unsupported") === true) {
        return `⚠️ "${str(r, "name") ?? "That file"}" is a ${
          str(r, "mimeType") ?? "type"
        } I cannot read as text — try drive.get_metadata instead, or open it directly.`;
      }
      const text = str(r, "text") ?? "";
      const capped = text.length > 800 ? text.slice(0, 800) + "…" : text;
      return [`${str(r, "name") ?? "(untitled)"}:`, "", capped || "(empty)"].join("\n");
    }
```

**Verify:** `bun run typecheck` passes.

---

## Step 10 — Stop the sync cron from touching Drive rows

**File:** `convex/gmail.ts` **(edit)**

**What this fixes.** `syncAll` walks `connectedAccounts.listActive`, which returns every `ACTIVE` row for every provider — it has never had to distinguish, because until this phase there was only one provider. The moment a Drive row exists, the mailbox-sync cron (`convex/crons.ts`, every 10–30 minutes) will try to run Gmail's `listMessages` against a token that only has `drive.readonly` scope. That fails with a 403 on every tick for every connected Drive account, forever, and pollutes the logs with a `gmail_sync_failed` line that has nothing to do with Gmail. One filter fixes it before it ships.

In `syncAll`, change:

```ts
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    for (const account of accounts) {
      if (account.provider !== "gmail") continue;
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

**Verify:** `bunx convex run gmail:syncAll '{}'` against dev, after Step 12's manual Drive connect below — confirm no `gmail_sync_failed` line appears for the Drive account in the Convex dashboard's log stream.

---

## Step 11 — `/connect drive`, and the same fix in `/sync` and `/accounts`

**File:** `convex/assistant.ts` **(edit)**

**What this does.** Three small changes, all in the command handlers, all downstream of the same fact as Step 10: a second provider now exists, and every place that used to assume "the connected account" meant Gmail needs to say so explicitly instead of assuming it.

In the `/help` list, add a line:

```ts
        "/connect <label> — connect a Gmail mailbox (read-only)",
        "/connect drive [label] — connect a Drive account (read-only, separate from Gmail)",
```

Replace `connectCommand`:

```ts
async function connectCommand(
  ctx: ActionCtx,
  userId: Id<"users">,
  text: string,
): Promise<string> {
  const words = text.split(/\s+/).slice(1).map((w) => w.toLowerCase());
  const isDrive = words.includes("drive");
  const label = (words.find((w) => w !== "drive") ?? "personal").replace(/[^a-z0-9_-]/g, "");
  if (!label) return "Give the mailbox a label, e.g. /connect recruiting or /connect drive";

  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!siteUrl) return "CONVEX_SITE_URL is not set on this deployment.";

  const provider = isDrive ? "google_drive" : "gmail";
  const { nonce } = await ctx.runMutation(internal.model.oauthStates.issue, {
    userId,
    label,
    provider,
  });

  const kind = isDrive ? "Drive account" : "Gmail mailbox";
  return [
    `Connect a ${kind} as "${label}":`,
    `${siteUrl}/oauth/google/start?state=${nonce}`,
    "",
    isDrive
      ? "Read-only — search and read documents only. Independent from any Gmail connection on the same address."
      : "Read-only access — this build cannot send, delete or modify anything.",
    "The link works once and expires in 10 minutes.",
  ].join("\n");
}
```

In `syncCommand`, filter to Gmail accounts before scheduling — the same fix as Step 10, applied to the manual `/sync` path:

```ts
async function syncCommand(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
    userId,
  });
  const active = accounts.filter((a) => a.status === "ACTIVE" && a.provider === "gmail");
  if (active.length === 0) return "Nothing to sync — no active mailboxes.";

  for (const account of active) {
    await ctx.scheduler.runAfter(0, internal.gmail.syncAccount, { accountId: account._id });
  }
  return `Syncing ${active.length} mailbox${active.length === 1 ? "" : "es"}. /accounts to see the result.`;
}
```

In `accountsCommand`, tag each row with its provider so `/accounts` doesn't read as "0 messages, broken" for a Drive row — it reads as "Drive, working as designed":

```ts
    const icon = account.status === "ACTIVE" ? "✅" : "⚠️";
    const providerLabel = account.provider === "google_drive" ? "Drive" : "Gmail";
    lines.push(
      `${icon} ${account.accountEmail} (${account.label}, ${providerLabel}) — ${account.status}`,
      `    ${count}${capped ? "+" : ""} messages · last sync ${
        account.lastSyncedAt ? formatInstant(account.lastSyncedAt, timezone) : "never"
      }`,
      `    scopes: ${account.scopesGranted.map((s) => s.split("/").pop()).join(", ")}`,
    );
```

(The message count and "last sync" line stay literal for a Drive row — it will always read `0 messages · last sync never`, which is accurate: Drive is queried live, never synced. Worth knowing, not worth a special case.)

**Verify:** `bun run typecheck` passes. On dev, `/connect drive` produces a link whose `authorizeUrl` (visible if you inspect the redirect, or just trust Step 5's regression check) requests `drive.readonly` and nothing else. After completing it, `/accounts` shows the new row tagged `Drive`.

---

## Step 12 — Update `SCOPE`

**File:** `convex/lib/prompts/assistant.ts` **(edit)**

**What this does.** `SCOPE`'s denial list currently states flatly that there is no tool for Drive. That's now false, and leaving it would make the assistant lie about its own capabilities the first time someone asks "can you check my Drive?" Two changes: the "complete list" intro line gains Drive, and the denial line drops it — replaced with an honest statement of what Drive access actually is (search + read, nothing more) and the "never let the model pick" rule stated as a rule the model itself must follow, not just a design intention on our end.

Change the opening of `SCOPE`:

```ts
const SCOPE = `SCOPE — what you actually are:

You are a personal assistant running on a fixed set of tools: projects, tasks,
reminders, people, and (once connected) reading Gmail or searching Drive. That
is the complete list. You have:
  - NO ability to write, read, or change code.
  - NO ability to open, inspect, or change Google Cloud Console, OAuth client
    settings, redirect URIs, environment variables, or any deployment.
  - NO visibility into server logs, error stack traces, or infrastructure —
    only whatever a tool result or an error message literally says.
  - NO tool for Calendar, Linear, WhatsApp, or sending/deleting email. These
    are not "not working yet" — they do not exist as tools at all.
  - Drive access, where connected, is READ-ONLY search and read —
    drive.search_files, drive.get_metadata, drive.read_content. There is NO
    tool that attaches a file to anything. When a document is needed (e.g.
    "attach my CV"), present the candidates you found (name, type, modified
    date) and wait for the user to pick one by name or id — never assume,
    infer, or silently choose which file they meant, even if only one result
    came back.
  - NO importance or spam classifier. Gmail's own label (SPAM, INBOX, ...) is
    the only signal available — use gmailLabel to filter by it. If asked for
    "anything unusual" or "anything important", you cannot judge that; say so
    and offer what you CAN do: filter by label, or search by keyword.
```

The rest of `SCOPE` (the standing-instructions paragraph and the final "when a request needs a capability that has no tool" paragraph) is unchanged.

**Verify:** `bun run typecheck` passes — this alone won't catch the wording change; Step 13's test does.

---

## Step 13 — Match the test to the new wording

**File:** `tests/unit/assistant-prompt.test.ts` **(edit)**

**What this does.** The existing test asserts the exact substring `"Calendar, Drive, Linear, WhatsApp"`, which no longer appears verbatim. Update it, and add one test that pins down the new Drive paragraph so a future edit can't silently drop the "never pick silently" rule the same way this step just removed the old denial.

Change the existing test:

```ts
  test("states scope boundaries: no code, no infra, no Calendar/Linear/WhatsApp tool", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("NO ability to write, read, or change code");
    expect(prompt).toContain("Google Cloud Console");
    expect(prompt).toContain("Calendar, Linear, WhatsApp");
    expect(prompt).toContain('Never say "I am checking / investigating');
  });
```

Add a new test right after it:

```ts
  test("states Drive is read-only search/read with no auto-attach", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("reading Gmail or searching Drive");
    expect(prompt).toContain("drive.search_files");
    expect(prompt).toContain("NO tool that attaches a file");
    expect(prompt).toContain("never assume, infer, or silently choose");
  });
```

**Verify:** `bun test tests/unit/assistant-prompt.test.ts` — all passing, including the two touched by this step.

---

## Done when

- [ ] `bun test` — every existing test still passes, plus the new `drive-client.test.ts` suite and the two changed/added assertions in `assistant-prompt.test.ts`
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex deploy` — succeeds
- [ ] On dev: `/connect drive` → tap the link → Google's consent screen shows only Drive's read-only scope, not Gmail's → Telegram receives "Connected Drive (...) as personal."
- [ ] `/accounts` shows two rows for the same address if you'd already connected Gmail — one tagged `Gmail`, one tagged `Drive` — each independently `ACTIVE`
- [ ] "Find my latest CV" (or `bunx convex run debug:planOnly '{"text":"find my latest cv"}'`) returns a short numbered-feeling list of candidates with names and modified dates — never a single file asserted as "the" CV
- [ ] Asking to attach one produces no tool call and no silent choice — there is no tool that could do it yet, and the reply says so in one sentence, not a workaround
- [ ] Revoking the Drive grant at myaccount.google.com/permissions and then asking a `drive.*` question produces "⚠️ Drive access needs reconnecting", not a raw error
- [ ] The Gmail sync cron's log stream shows no `gmail_sync_failed` line attributable to the Drive account, across at least one full cron tick

```bash
git add -A && git commit -m "Phase 11: Drive as a second, read-only connected account"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/connectors/drive/oauth.ts` | Drive's OAuth handshake. Same client as Gmail, `drive.readonly` only. |
| `convex/connectors/drive/client.ts` | Speaks Drive's REST API. MIME gating and query-building live here. |
| `convex/drive.ts` | Completes the Drive OAuth handshake; mints access tokens for tool calls. No sync loop. |
| `convex/model/oauthStates.ts` | The handshake's nonce table — now carries which connector to hand off to. |
| `convex/http.ts` | The two public OAuth routes, branching on that carried provider. |
| `convex/lib/tools/catalog.ts` | Tool contracts: the three Drive tools, `account.connect_link`'s new argument. |
| `convex/tools/router.ts` | Executes the Drive tools; resolves accounts by provider, never mixes Gmail and Drive rows. |
| `convex/lib/tools/outcomes.ts` | Turns Drive tool results into the text the user reads. |
| `convex/gmail.ts` | Unchanged except the one filter keeping the sync cron off Drive rows. |
| `convex/assistant.ts` | `/connect drive`, and the same provider-awareness in `/sync` and `/accounts`. |
| `convex/lib/prompts/assistant.ts` | `SCOPE` — what the model is told it can and cannot do with Drive. |

---

## Next

**Phase 6 — Draft, approve, send (when it lands).** That's the phase where `email.create_draft` and `email.update` start accepting a `fileId` chosen from a `drive.search_files` result, `drafts.attachmentFileIds` gets its first real write, and `security/hash.ts`'s `payloadHash` folds those file ids into the same hash it already folds `to`/`cc`/`subject`/`body` into — so swapping an attachment after approval voids the approval exactly as editing the subject line would. Nothing in this phase needs to change for that to work; the schema field and the design were already waiting.
