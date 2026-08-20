// Pure. Classifying a provider's failure decides whether the chain falls
// through or dies, so it is worth testing without a network.

/**
 * A provider that is configured but out of credit is a CONFIGURATION problem,
 * not a bug — the right response is to use the next provider, exactly as for a
 * rate limit.
 *
 * Vendors disagree on the status code for this. Measured 19 Aug 2026:
 *   - OpenAI  → 429 `insufficient_quota`      (already retriable by status)
 *   - Anthropic → 400 "credit balance is too low"  (would otherwise be fatal)
 *
 * Matching on the body is narrow on purpose. A blanket "400 is retriable"
 * would swallow malformed-request bugs, which must stay loud.
 */
const QUOTA_SIGNALS = [
  "insufficient_quota",
  "credit balance is too low",
  "no credits remaining",
  "exceeded your current quota",
  "billing_not_active",
  "quota_exceeded",
  // Gemini free tier. RESOURCE_EXHAUSTED is the status Google returns for a
  // per-model RPM/RPD limit, which is the ordinary way this project runs out.
  "resource_exhausted",
  "rate limit",
  "too many requests",
];

export function isQuotaExhausted(body: string): boolean {
  const haystack = body.toLowerCase();
  return QUOTA_SIGNALS.some((signal) => haystack.includes(signal));
}
