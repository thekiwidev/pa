export const TIERS = [
  "CHEAP_STRUCTURED", // classification, extraction, routing
  "REASON",           // planning, multi-step decisions
  "DRAFT",            // prose you will read and send
  "TRANSCRIBE",       // audio → text
  "VISION",           // images and PDFs → text
  "EMBED",            // Phase 17 only
] as const;

export type Tier = (typeof TIERS)[number];

/**
 * Every AI call site names a task from this list. Add a task when its
 * phase arrives — do not call a tier directly from feature code.
 */
export const TASKS = {
  CHAT_REPLY:          { tier: "REASON" },
  // PLAN_TOOLS emits a tool proposal against a fixed catalogue — structured
  // output, not prose. It sat on REASON and cost a high-thinking flash call on
  // every single inbound message, which is what exhausted the free-tier quota
  // after two or three messages. CHEAP_STRUCTURED is both what the work
  // actually is and a different per-model quota bucket.
  PLAN_TOOLS:          { tier: "CHEAP_STRUCTURED" },  // Phase 2
  // The second pass, run ONLY when a skill matched this message and tools
  // actually executed. Deliberately DRAFT tier, not REASON: this is "prose
  // you will read", which is exactly what the tier is for, and it keeps the
  // extra call off the same quota bucket as PLAN_TOOLS.
  COMPOSE_REPLY:       { tier: "DRAFT" },
  CLASSIFY_IMPORTANCE: { tier: "CHEAP_STRUCTURED" },  // Phase 4
  SUMMARIZE_THREAD:    { tier: "CHEAP_STRUCTURED" },  // Phase 5
  DRAFT_REPLY:         { tier: "DRAFT" },             // Phase 6
  TRANSCRIBE_VOICE:    { tier: "TRANSCRIBE" },        // Phase 9
  // Images the user sends are mostly TEXT ON A PICTURE — flyers, carousel
  // slides, screenshots — so the job is transcription, not description, and
  // the output contract says so.
  READ_IMAGE:          { tier: "VISION" },
  READ_DOCUMENT:       { tier: "VISION" },
  EXTRACT_COMMITMENTS: { tier: "CHEAP_STRUCTURED" },
  COMPOSE_BRIEF:       { tier: "DRAFT" },             // Phase 12
} as const satisfies Record<string, { tier: Tier }>;

export type TaskName = keyof typeof TASKS;

/** GEMINI_MODEL_DRAFT, OPENAI_MODEL_REASON, and so on. */
export function modelEnvVar(providerId: string, tier: Tier): string {
  return `${providerId.toUpperCase()}_MODEL_${tier}`;
}

/**
 * A tier's model variable holds a COMMA-SEPARATED FALLBACK CHAIN, tried left
 * to right:
 *
 *   GEMINI_MODEL_REASON=gemini-3.7-flash,gemini-3.6-flash,gemini-2.5-flash
 *
 * Why a chain and not one name: model availability is not stable. A newer
 * model can reject a field an older one accepts, get rate-limited on its own
 * quota, or simply not exist yet on your key. Falling back one generation is
 * almost always better than falling through to a different vendor.
 */
export function modelChain(
  providerId: string,
  tier: Tier,
  env: Record<string, string | undefined>,
): string[] {
  const raw = env[modelEnvVar(providerId, tier)];
  if (!raw) return [];
  return raw.split(",").map((m) => m.trim()).filter(Boolean);
}
