// Verifying Google's OIDC push token. Fetches Google's public keys, so it is
// a connector rather than pure lib — but the decoding and every claim check
// live in lib/email/pubsub.ts and are tested there.
//
// RS256 over Web Crypto, in the default V8 runtime. No jose, no jsonwebtoken,
// no "use node".

import { decodeJwt, checkJwtClaims, type ClaimExpectation } from "../../lib/email/pubsub";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/**
 * Google rotates these keys, so they cannot be pinned — but they change on
 * the order of days, and a push arrives every few minutes. Caching for an
 * hour turns one fetch-per-notification into one fetch-per-hour.
 *
 * Module-level state in a Convex action is per-instance and may vanish at any
 * time. That is fine: the only cost of a cold cache is one extra fetch, and
 * correctness never depends on it.
 */
let cache: { fetchedAtMs: number; keys: Jwk[] } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function googleKeys(force = false): Promise<Jwk[]> {
  if (!force && cache && Date.now() - cache.fetchedAtMs < CACHE_TTL_MS) {
    return cache.keys;
  }
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`google jwks ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  cache = { fetchedAtMs: Date.now(), keys: data.keys ?? [] };
  return cache.keys;
}

async function verifySignature(
  key: Jwk,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const imported = await crypto.subtle.importKey(
    "jwk",
    { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    imported,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
  );
}

/**
 * Is this a genuine, current, correctly-addressed Google push token?
 *
 * Order matters: claims are checked BEFORE the signature, so a stale or
 * misaddressed token costs no crypto and no key fetch. The signature is the
 * expensive check and the last one.
 */
export async function verifyGooglePushToken(
  token: string,
  expect: ClaimExpectation,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, reason: "malformed token" };

  if (decoded.header.alg !== "RS256") {
    // Refusing anything else by name is what closes the "alg: none" family of
    // attacks — a token that says it is unsigned must never be treated as one.
    return { ok: false, reason: `unexpected alg ${String(decoded.header.alg)}` };
  }

  const claims = checkJwtClaims(decoded.payload, expect);
  if (!claims.ok) return claims;

  const kid = decoded.header.kid;
  if (typeof kid !== "string") return { ok: false, reason: "no key id" };

  for (const force of [false, true]) {
    const keys = await googleKeys(force);
    const key = keys.find((k) => k.kid === kid);
    if (!key) continue; // Unknown kid: refetch once, in case keys just rotated.

    const valid = await verifySignature(key, decoded.signingInput, decoded.signature);
    return valid ? { ok: true } : { ok: false, reason: "signature did not verify" };
  }

  return { ok: false, reason: "signing key not found" };
}
