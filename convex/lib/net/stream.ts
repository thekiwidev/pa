// Pure. Reading a response body up to a byte cap WITHOUT buffering the rest.
//
// `await res.text()` and `await res.arrayBuffer()` pull the whole body into
// memory before any size check can run, so a hostile or huge page defeats the
// cap it is checked against. This reads chunk by chunk and stops (cancelling
// the stream) the moment the cap is passed.

export interface Capped {
  bytes: Uint8Array;
  /** True when the body was longer than the cap and the rest was dropped. */
  truncated: boolean;
}

export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Capped> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, truncated };
}

/** UTF-8 text, cut at the cap. A multi-byte character cut in half becomes U+FFFD. */
export async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode((await readCapped(body, maxBytes)).bytes);
}
