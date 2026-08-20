// Pure module: no ctx, no I/O, no Convex imports.
// Everything under convex/lib/ follows this rule — it is what lets
// `bun test` run the domain logic with no Convex runtime, and it is
// the lock-in mitigation from the build plan's section 0.2.

/**
 * Read a required environment variable, or fail with a message that
 * names it. Convex has no boot phase to crash, so a missing variable
 * must surface deliberately rather than as an `undefined` at 03:00.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on this deployment`);
  return value;
}

/**
 * Variables that must be present RIGHT NOW for the app to function.
 * Grow this list as each phase starts consuming a variable — it is
 * what makes /health meaningful instead of decorative.
 *
 * Phase 1 adds: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
 *               TELEGRAM_OWNER_ID, GEMINI_API_KEY, AI_PROVIDER_PRIORITY
 * Phase 3 adds: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 * Phase 8 adds: GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_AUDIENCE,
 *               GOOGLE_PUBSUB_SA_EMAIL
 */
export const REQUIRED_NOW: readonly string[] = ["ENCRYPTION_KEY"];

export function checkConfig(): { ok: boolean; missingCount: number } {
  const missing = REQUIRED_NOW.filter((name) => !process.env[name]);
  return { ok: missing.length === 0, missingCount: missing.length };
}
