// Pure. What a Linear personal API key must look like before it is sealed.
//
// A 401 from Linear reads the same whether the key was revoked or merely
// pasted with quotes or a trailing newline into `convex env set`. Cleaning
// and shape-checking before sealing removes the second cause entirely.

/** Strip whitespace and one layer of surrounding quotes. */
export function cleanLinearKey(raw: string): string {
  const trimmed = raw.trim();
  const unquoted = /^(["'])(.*)\1$/.exec(trimmed);
  return (unquoted ? (unquoted[2] ?? "") : trimmed).trim();
}

/** Personal API keys start "lin_api_"; anything else is the wrong secret. */
export function looksLikeLinearKey(key: string): boolean {
  return /^lin_api_[A-Za-z0-9]+$/.test(key);
}

export const LINEAR_RECONNECT_HINT =
  "Linear rejected the saved key (401). Make a new personal API key in Linear " +
  "(Settings → Security & access → Personal API keys), then run:\n" +
  "bunx convex env set LINEAR_API_KEY <key>\n" +
  "bunx convex run debug:connectLinear '{}'";
