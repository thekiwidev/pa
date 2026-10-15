// Google OAuth 2.0, over plain fetch. No googleapis SDK — that requires
// "use node" (512 MB) to call two JSON endpoints.

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Phase 3 is READ-ONLY, and the scope list says so.
 *
 * Never request https://mail.google.com/ — that is full access.
 * Phase 6 adds gmail.compose + gmail.send. Phase 8 adds gmail.modify.
 * Add each ONLY when its phase starts; there is a test asserting this list.
 */
export const GMAIL_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

/**
 * Additive on top of GMAIL_READONLY_SCOPES, never a replacement for it —
 * Phase 3's own scope test still asserts GMAIL_READONLY_SCOPES contains only
 * gmail.readonly, and that must keep being true.
 *
 * Google does NOT retroactively grant a scope to a token issued without it.
 * An account connected before this phase must be reconnected once (send
 * /connect with the SAME label again) for its refresh token to carry these.
 * Phase 8 adds a third list with gmail.modify.
 */
export const GMAIL_SEND_SCOPES = [
  ...GMAIL_READONLY_SCOPES,
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

/**
 * Phase 8. `gmail.modify` is what archive / label / mark-read need.
 *
 * It is NOT `https://mail.google.com/` and must never become it: modify can
 * move and label a message, and can trash one, but cannot permanently delete
 * — which is exactly the line this project wants. There is no undo for a
 * hard delete, so the scope that permits one is never requested.
 */
export const GMAIL_MODIFY_SCOPES = [
  ...GMAIL_SEND_SCOPES,
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

/**
 * Phase 10. Read the calendar, and write events.
 *
 * `calendar.events` covers create and update. There is no separate delete
 * scope to withhold, so restraint lives in the tool catalogue instead: there
 * is no delete tool, and an event with attendees needs an approval.
 */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/**
 * Phase 11. Read Drive, and nothing else — no create, no share, no delete,
 * not in this phase and possibly not ever.
 *
 * `drive.readonly` sees every file the account can see. The narrower
 * `drive.file` would only see files this app created, which is useless for
 * "find my CV" — the whole point is reaching documents that already exist.
 * The mitigation is not a smaller scope, it is that the model NARROWS and
 * you CHOOSE; nothing is ever attached without your tap.
 */
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

/**
 * What a fresh /connect actually asks Google for.
 *
 * One grant covers Gmail, Calendar and Drive rather than three separate
 * OAuth flows, because they are all the same Google account and Google
 * issues one refresh token per grant. `scopesGranted` on the account row
 * records what was really given, and every tool checks it before assuming
 * a capability — see requireScope in tools/router.ts.
 *
 * Google does NOT retroactively grant a scope to a token issued without it.
 * An account connected before this list grew must reconnect once. That is
 * the weekly /reconnect anyway, so the migration path is: do nothing, and it
 * heals itself the next time the token expires.
 */
export const GOOGLE_CONNECT_SCOPES = [
  ...GMAIL_MODIFY_SCOPES,
  ...CALENDAR_SCOPES,
  ...DRIVE_SCOPES,
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
    scope: GOOGLE_CONNECT_SCOPES.join(" "),
    state,
    // Both are required to be GIVEN a refresh token at all. Without
    // prompt=consent, a second authorization of an already-granted account
    // returns an access token only, and the account silently cannot refresh.
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
    // invalid_grant is what a 7-day Testing-mode expiry looks like, and what a
    // user-revoked grant looks like. Both need /reconnect, not a retry.
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
