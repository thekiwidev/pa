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
  //
  // Moved back to REASON on 2026-10-15. On flash-lite it read context badly:
  // "when did this come in?" under an alert became a mailbox search. It is
  // the one call that decides everything else, so it gets the better model;
  // route it to a provider whose REASON tier fits the free quota (see
  // docs/RUNBOOK-cleanup.md) rather than starving it.
  PLAN_TOOLS:          { tier: "REASON" },
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
  // Was CHEAP_STRUCTURED. A transcript is the one input where getting
  // attribution wrong silently manufactures — or loses — someone's task.
  // This is a per-transcript cost, not per-message, so REASON is affordable
  // here in a way it would not be for PLAN_TOOLS.
  EXTRACT_COMMITMENTS: { tier: "REASON" },
  SUMMARIZE_MEETING:   { tier: "DRAFT" },             // the personal TL;DR
  COMPOSE_BRIEF:       { tier: "DRAFT" },             // Phase 12
  // Folds older chat turns into a short running summary — memory.
  SUMMARIZE_CONVERSATION: { tier: "CHEAP_STRUCTURED" },
  // Saved posts (2026-10-15). One call reads every slide of a post and files
  // it: title, summary, the films / tools / tips in it. VISION because the
  // slides are the content.
  EXTRACT_POST:        { tier: "VISION" },
  // A short video from a post. TRANSCRIBE because only providers that take
  // audio/video inline (Gemini) are on that tier.
  TRANSCRIBE_VIDEO:    { tier: "TRANSCRIBE" },
  // A saved post written up as a full Notion note: prose the owner reads, so
  // DRAFT. One call per "add this to my notes", not per message.
  WRITE_POST_NOTE:     { tier: "DRAFT" },
  // "Is this saved item genuinely useful for what they are doing now?"
  JUDGE_RELEVANCE:     { tier: "CHEAP_STRUCTURED" },
  // Scripture (2026-10-19). Choosing the passage is a judgement about the
  // owner's day and about what a verse means in context: REASON. It emits
  // references only — the text comes from the imported Bible.
  CHOOSE_SCRIPTURE:    { tier: "REASON" },
  // The reflection, prayer points and prayer: prose they will read. A few
  // calls a day.
  WRITE_PRAYER:        { tier: "DRAFT" },
  // Not a chat task: names the EMBED tier for AI_ROUTE_EMBED_TEXT.
  EMBED_TEXT:          { tier: "EMBED" },
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
 *   GEMINI_MODEL_REASON=gemini-3.5-flash,gemini-3.6-flash,gemini-3-flash-preview
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
