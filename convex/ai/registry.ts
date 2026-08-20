import { TASKS, modelEnvVar, modelChain, type TaskName } from "../lib/ai/tiers";
import { resolveProviderChain, PROVIDER_CAPABILITIES } from "../lib/ai/resolve";
import type { AIProvider, AIResult } from "./types";
import { AllProvidersFailed } from "./types";
import { isQuotaExhausted } from "../lib/ai/errors";
import type { UntrustedBlock } from "../lib/ai/prompt";
import { geminiProvider } from "./providers/gemini";
import { openaiProvider } from "./providers/openai";
import { anthropicProvider } from "./providers/anthropic";
import { openrouterProvider } from "./providers/openrouter";

const PROVIDERS: Record<string, AIProvider> = {
  gemini: geminiProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  openrouter: openrouterProvider,
};

export interface RunTaskArgs {
  system: string;
  input: string;
  untrusted?: UntrustedBlock[];
  audio?: { mimeType: string; dataBase64: string };
  maxOutputTokens?: number;
}

/**
 * The single entry point every feature calls. Resolves the provider chain,
 * looks up the model for the task's tier, calls the provider, and falls
 * through to the next one on 429/5xx.
 *
 * This runs in an ACTION, always. It calls `fetch`, which Convex forbids in a
 * query or mutation — correctly, because a model call is not part of a
 * transaction.
 */
export async function runTask(task: TaskName, args: RunTaskArgs): Promise<AIResult> {
  const { tier } = TASKS[task];
  const chain = resolveProviderChain(process.env, tier, task);

  // Collect EVERY failure, not just the last one.
  //
  // The previous version reported only `lastError`, which meant a Gemini
  // rate-limit surfaced to the user as an Anthropic billing error — the real
  // cause was invisible and the message pointed at the wrong vendor. An
  // aggregate message costs nothing and names the actual problem.
  const failures: string[] = [];

  for (const providerId of chain) {
    const capability = PROVIDER_CAPABILITIES.find((p) => p.id === providerId);
    const provider = PROVIDERS[providerId];
    if (!capability || !provider) continue;

    const apiKey = process.env[capability.apiKeyVar];
    if (!apiKey) {
      failures.push(`${providerId}: ${capability.apiKeyVar} not set`);
      continue;
    }

    const models = modelChain(providerId, tier, process.env);
    if (models.length === 0) {
      failures.push(`${providerId}: ${modelEnvVar(providerId, tier)} not set`);
      continue;
    }

    // Try each model in the tier's fallback chain before moving to the next
    // provider. A model that rejects a request field, or does not exist on
    // this key, should cost you one generation — not your whole vendor.
    for (const model of models) {
      try {
        return await provider.run({ tier, ...args }, model, apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${providerId}/${model}: ${detail}`);
        console.warn(`ai_attempt_failed task=${task} provider=${providerId} model=${model}: ${detail}`);
      }
    }
  }

  // If EVERY attempt was a quota problem, this is a "come back later", not a
  // bug. The orchestrator turns that into one sentence instead of dumping a
  // truncated stack trace into Telegram.
  throw new AllProvidersFailed(
    task,
    failures,
    failures.length > 0 && failures.every(isQuotaExhausted),
  );
}
