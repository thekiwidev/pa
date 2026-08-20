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
 * Phase 8 adds: GOOGLE_PUBSUB_TOPIC, GOOGLE_PUBSUB_AUDIENCE,
 *               GOOGLE_PUBSUB_SA_EMAIL
 */
export const REQUIRED_NOW: readonly string[] = [
  "ENCRYPTION_KEY",          // Phase 0
  "TELEGRAM_BOT_TOKEN",      // Phase 1
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_OWNER_ID",
  "AI_PROVIDER_PRIORITY",
  "GEMINI_API_KEY",
  "GEMINI_MODEL_REASON",           // chat + compose
  "GEMINI_MODEL_CHEAP_STRUCTURED", // PLAN_TOOLS — every inbound message
  "USER_TIMEZONE",           // Phase 2
  "GEMINI_MODEL_TRANSCRIBE", // Phase 9 — voice notes
  "GOOGLE_CLIENT_ID",        // Phase 3 — Gmail OAuth
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
];

export function checkConfig(): { ok: boolean; missingCount: number } {
  const missing = REQUIRED_NOW.filter((name) => !process.env[name]);
  return { ok: missing.length === 0, missingCount: missing.length };
}
