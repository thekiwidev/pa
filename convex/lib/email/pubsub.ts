// Pure. No ctx, no fetch. Parsing and validating what arrives at
// /webhooks/gmail, minus the one step that needs the network (fetching
// Google's public keys to check the signature — see connectors/google/jwt.ts).
//
// WHY THIS IS SO CAREFUL
//
// This endpoint is on `.convex.site`, which is public. Nothing about the URL
// is secret and nothing about it can be. So the ONLY thing standing between
// a stranger and "make this deployment sync a mailbox" is the OIDC token
// Google attaches to every push — and a token that is decoded but not
// verified is worse than no token, because it looks like a check.
//
// The rule this file exists to enforce: the envelope tells you WHICH mailbox
// changed, and it is never trusted to tell you anything else. It carries no
// message content, and none is read from it.

export interface PushEnvelope {
  /** The mailbox this notification is about. */
  emailAddress: string;
  /** Gmail's cursor — everything after this changed. */
  historyId: string;
}

/**
 * Pull the Gmail notification out of a Pub/Sub push body.
 *
 * The shape is nested and base64'd:
 *   { message: { data: "<base64 of {emailAddress, historyId}>" }, ... }
 *
 * Returns null rather than throwing on anything malformed. A push that
 * cannot be parsed must be ACKed with a 200 and dropped — returning an error
 * makes Pub/Sub redeliver it forever.
 */
export function parsePushEnvelope(body: unknown): PushEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const data = (message as { data?: unknown }).data;
  if (typeof data !== "string" || data.length === 0) return null;

  let decoded: string;
  try {
    decoded = atob(data.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const emailAddress = (parsed as { emailAddress?: unknown }).emailAddress;
  const historyId = (parsed as { historyId?: unknown }).historyId;

  if (typeof emailAddress !== "string" || emailAddress.length === 0) return null;
  // Gmail sends historyId as a NUMBER in the push payload and expects a
  // STRING back on the history endpoint. Normalising here means no caller
  // has to remember that.
  if (typeof historyId !== "string" && typeof historyId !== "number") return null;

  return { emailAddress, historyId: String(historyId) };
}

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** The exact bytes the signature covers: "<header>.<payload>". */
  signingInput: string;
  signature: Uint8Array;
}

function base64UrlToBytes(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Split a JWT into its parts. Decoding only — this proves nothing. */
export function decodeJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = base64UrlToJson(parts[0]!);
  const payload = base64UrlToJson(parts[1]!);
  if (!header || !payload) return null;

  try {
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: base64UrlToBytes(parts[2]!),
    };
  } catch {
    return null;
  }
}

export interface ClaimExpectation {
  /** GOOGLE_PUBSUB_AUDIENCE — the URL this endpoint is reachable at. */
  audience: string;
  /** GOOGLE_PUBSUB_SA_EMAIL — the service account the subscription pushes as. */
  serviceAccountEmail: string;
  nowMs: number;
  /** Tolerance for clock skew between Google and this deployment. */
  leewaySeconds?: number;
}

/**
 * Check everything about a token that does not require a key.
 *
 * Returned as a reason string rather than a boolean, because every rejection
 * here is written to the audit log and "webhook rejected" with no reason is
 * an entry nobody can act on.
 */
export function checkJwtClaims(
  payload: Record<string, unknown>,
  expect: ClaimExpectation,
): { ok: true } | { ok: false; reason: string } {
  const leeway = expect.leewaySeconds ?? 60;
  const nowSeconds = Math.floor(expect.nowMs / 1000);

  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    return { ok: false, reason: `unexpected issuer ${String(iss)}` };
  }

  if (payload.aud !== expect.audience) {
    return { ok: false, reason: "audience mismatch" };
  }

  // The service account is WHO is calling. Without this check any Google
  // account could mint a token for this audience.
  const email = payload.email;
  if (typeof email !== "string" || email !== expect.serviceAccountEmail) {
    return { ok: false, reason: "unexpected service account" };
  }

  // Google sets email_verified on service-account tokens. Absent is fine on
  // some token shapes; explicitly false never is.
  if (payload.email_verified === false) {
    return { ok: false, reason: "email not verified" };
  }

  const exp = payload.exp;
  if (typeof exp !== "number") return { ok: false, reason: "no expiry" };
  if (nowSeconds > exp + leeway) return { ok: false, reason: "token expired" };

  const iat = payload.iat;
  if (typeof iat === "number" && nowSeconds + leeway < iat) {
    return { ok: false, reason: "token issued in the future" };
  }

  return { ok: true };
}
