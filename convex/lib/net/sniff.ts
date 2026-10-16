// Pure. What an image actually is, from its first bytes.
//
// CDNs often answer with application/octet-stream or nothing at all, and an
// image the vision model is never shown is a slide silently dropped.

export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12) {
    const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (ascii(0, 3) === "GIF") return "image/gif";
  }
  return null;
}
