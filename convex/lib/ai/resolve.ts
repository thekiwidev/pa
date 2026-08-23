import type { Tier, TaskName } from "./tiers";

export type ProviderId = "gemini" | "openai" | "anthropic" | "openrouter";

export class NoProviderAvailable extends Error {
  constructor(tier: Tier) {
    super(`No configured AI provider supports tier ${tier}`);
    this.name = "NoProviderAvailable";
  }
}

interface ProviderCapability {
  id: ProviderId;
  apiKeyVar: string;
  tiers: readonly Tier[];
}

/** A provider is "configured" purely by the presence of its key. */
export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  {
    id: "gemini",
    apiKeyVar: "GEMINI_API_KEY",
    tiers: ["CHEAP_STRUCTURED", "REASON", "DRAFT", "TRANSCRIBE", "VISION", "EMBED"],
  },
  {
    id: "openai",
    apiKeyVar: "OPENAI_API_KEY",
    // No TRANSCRIBE: /v1/responses has no audio input part, and the provider
    // silently dropped req.audio while this list claimed otherwise — a voice
    // note routed here got a confident answer to an empty prompt. Images and
    // PDFs (VISION) are genuinely supported.
    tiers: ["CHEAP_STRUCTURED", "REASON", "DRAFT", "VISION", "EMBED"],
  },
  {
    id: "anthropic",
    apiKeyVar: "ANTHROPIC_API_KEY",
    tiers: ["CHEAP_STRUCTURED", "REASON", "DRAFT", "VISION"], // no audio, no embeddings
  },
  {
    id: "openrouter",
    apiKeyVar: "OPENROUTER_API_KEY",
    // Whatever the configured model per tier actually supports is on you —
    // OpenRouter fronts hundreds of models with wildly different
    // capabilities. Listed as full-capability here; a model that can't do
    // audio for TRANSCRIBE will just fail that one call, same as picking
    // the wrong Gemini model would.
    tiers: ["CHEAP_STRUCTURED", "REASON", "DRAFT", "TRANSCRIBE", "VISION", "EMBED"],
  },
];

const DEFAULT_PRIORITY: ProviderId[] = ["gemini", "openai", "anthropic", "openrouter"];

/**
 * Precedence, exactly as the build plan's §0.3 specifies:
 *   1. explicit override at the call site   (handled by the caller)
 *   2. AI_ROUTE_<TASK>                      (this function)
 *   3. AI_PROVIDER_PRIORITY order           (this function)
 *   4. key present AND tier supported       (this function)
 *
 * Returns primary first, then fallbacks. Throws if the list is empty —
 * never silently degrade.
 */
export function resolveProviderChain(
  env: Record<string, string | undefined>,
  tier: Tier,
  task?: TaskName,
): ProviderId[] {
  const priority = (env.AI_PROVIDER_PRIORITY ?? DEFAULT_PRIORITY.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProviderId[];

  const eligible = PROVIDER_CAPABILITIES.filter(
    (p) => Boolean(env[p.apiKeyVar]) && p.tiers.includes(tier),
  ).map((p) => p.id);

  let chain = priority.filter((id) => eligible.includes(id));

  // Per-task override moves one provider to the front, keeping the rest
  // available as fallbacks.
  const override = task ? (env[`AI_ROUTE_${task}`] as ProviderId | undefined) : undefined;
  if (override && chain.includes(override)) {
    chain = [override, ...chain.filter((id) => id !== override)];
  }

  if (chain.length === 0) throw new NoProviderAvailable(tier);
  return chain;
}
