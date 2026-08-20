// Envelope encryption for provider credentials.
//
// Refresh tokens NEVER touch an environment variable. ENCRYPTION_KEY encrypts
// them; the ciphertext lives on the connectedAccounts document.
//
// Web Crypto is available in the Convex V8 runtime, so this needs no Node
// runtime and no npm dependency — `"use node"` would cost 512 MB against the
// 20 GB-hour budget instead of 64 MB.
//
// Decrypt ONLY here, ONLY at the moment of use. Never log the plaintext and
// never pass it into a prompt.

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12; // 96 bits, the AES-GCM standard
const TAG_BYTES = 16;

export interface SealedCredential {
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  authTag: ArrayBuffer;
}

function decodeKey(): Uint8Array<ArrayBuffer> {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set on this deployment");

  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
  if (bytes.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes for AES-256, got ${bytes.length}`,
    );
  }
  return bytes;
}

async function importKey(usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", decodeKey(), ALGORITHM, false, [usage]);
}

/**
 * The auth tag is split out of the ciphertext rather than left appended.
 *
 * Web Crypto returns tag-appended output, but the schema stores the three
 * parts separately — which keeps the stored shape honest about what it holds
 * and matches what a non-Web-Crypto implementation would produce if this ever
 * has to be decrypted somewhere else.
 */
export async function seal(plaintext: string): Promise<SealedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey("encrypt");

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );

  const split = sealed.length - TAG_BYTES;
  return {
    ciphertext: sealed.slice(0, split).buffer as ArrayBuffer,
    iv: iv.buffer as ArrayBuffer,
    authTag: sealed.slice(split).buffer as ArrayBuffer,
  };
}

export async function open(sealed: SealedCredential): Promise<string> {
  const ciphertext = new Uint8Array(sealed.ciphertext);
  const authTag = new Uint8Array(sealed.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  const key = await importKey("decrypt");

  // A failure here means a wrong key or tampered ciphertext. Both are worth
  // saying out loud rather than surfacing as a generic OperationError.
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: new Uint8Array(sealed.iv) },
      key,
      combined,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(
      "credential decryption failed — ENCRYPTION_KEY does not match the one " +
        "used to store this account, or the ciphertext was altered",
    );
  }
}
