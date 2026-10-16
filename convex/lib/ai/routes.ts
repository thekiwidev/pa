import { TASKS, TIERS, modelChain, modelEnvVar, type TaskName, type Tier } from "./tiers";
import { resolveProviderChain, PROVIDER_CAPABILITIES, type ProviderId } from "./resolve";

type Env = Record<string, string | undefined>;

/** Embedding model per provider when `<PROVIDER>_MODEL_EMBED` is unset. */
export const DEFAULT_EMBED_MODEL: Record<"gemini" | "openai", string> = {
  gemini: "gemini-embedding-001",
  openai: "text-embedding-3-small",
};

/**
 * The ONE provider that embeds. There is deliberately no fallback: Gemini and
 * OpenAI vectors are both 768-d, so a mixed index raises no error, but the two
 * spaces are unrelated and every cross-provider comparison is noise. A failed
 * embed returns nothing and search falls back to keywords for that item.
 *
 * Gemini by default because its embedding model is on the free tier and
 * OpenAI's is not in the complimentary-token pools. `AI_ROUTE_EMBED_TEXT`
 * pins it, but only to a provider whose key is set.
 */
export function embedProvider(env: Env): "gemini" | "openai" | null {
  const pinned = env.AI_ROUTE_EMBED_TEXT;
  if (pinned === "openai" && env.OPENAI_API_KEY) return "openai";
  if (pinned === "gemini" && env.GEMINI_API_KEY) return "gemini";
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.OPENAI_API_KEY) return "openai";
  return null;
}

export interface TaskRoute {
  task: TaskName;
  tier: Tier;
  /** In the order runTask tries them. Providers with no ladder for the tier are left out, as runTask skips them. */
  providers: { id: ProviderId; models: string[] }[];
}

/** What `runTask` would try for every task, read from env alone. */
export function describeRoutes(env: Env): TaskRoute[] {
  return (Object.keys(TASKS) as TaskName[]).map((task) => {
    const { tier } = TASKS[task];
    if (tier === "EMBED") {
      const id = embedProvider(env);
      return {
        task,
        tier,
        providers: id ? [{ id, models: [modelChain(id, "EMBED", env)[0] ?? DEFAULT_EMBED_MODEL[id]] }] : [],
      };
    }
    let chain: ProviderId[] = [];
    try {
      chain = resolveProviderChain(env, tier, task);
    } catch {
      chain = [];
    }
    return {
      task,
      tier,
      providers: chain
        .map((id) => ({ id, models: modelChain(id, tier, env) }))
        .filter((p) => p.models.length > 0),
    };
  });
}

/**
 * Model ids Google has retired or redirected to a paid successor. Kept here,
 * not in feature code, because this is a config lint: it never picks a
 * model, it only warns about one already set.
 *
 * gemini-3.7-flash: deprecated 2026-10, auto-redirected to gemini-3.8-flash.
 * gemini-2.5-*: 404 on the free key since 2026-08-20 (MEMORY.md).
 */
const RETIRED = [/^gemini-3\.7-flash$/, /^gemini-2\.5-/];

/**
 * `gemini-flash-latest` and friends float to Google's newest model, which is
 * how a free ladder quietly ends on a paid model. Pin names instead.
 */
const FLOATING = /^gemini-.*-latest$/;

export function routeWarnings(env: Env): string[] {
  const warnings: string[] = [];
  for (const { id } of PROVIDER_CAPABILITIES) {
    for (const tier of TIERS) {
      const name = modelEnvVar(id, tier);
      for (const model of modelChain(id, tier, env)) {
        if (RETIRED.some((r) => r.test(model))) warnings.push(`${name}: ${model} is retired; remove it`);
        else if (FLOATING.test(model)) warnings.push(`${name}: ${model} floats to Google's newest model, which may be paid; pin a name`);
      }
    }
  }
  return warnings;
}
