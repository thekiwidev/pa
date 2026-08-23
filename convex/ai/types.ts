import type { Tier } from "../lib/ai/tiers";
import type { ProviderId } from "../lib/ai/resolve";
import type { UntrustedBlock } from "../lib/ai/prompt";
import { isQuotaExhausted } from "../lib/ai/errors";

export interface MediaPart {
  mimeType: string;
  dataBase64: string;
}

export interface AIRequest {
  tier: Tier;
  system: string;
  input: string;
  /** External, attacker-controllable content. Wrapped, never merged into `input`. */
  untrusted?: UntrustedBlock[];
  /**
   * Inline media: audio for TRANSCRIBE, images and PDFs for VISION. Base64,
   * capped by the provider.
   *
   * This is untrusted content of a different shape. Whatever a voice note
   * says or an image depicts, it is TRANSCRIBED or DESCRIBED, never obeyed —
   * and the prompts for those tasks permit no output but a transcript or a
   * transcription, so there is no field an instruction inside the media could
   * act through. (Invariant I-2.) That matters more for images than audio:
   * "IGNORE PREVIOUS INSTRUCTIONS" printed on a flyer is a real attack, and
   * the defence is structural, not a plea in the prompt.
   *
   * An array because Telegram sends a carousel as several photos and the
   * whole point is to read them as one document.
   */
  media?: MediaPart[];
  maxOutputTokens?: number;
}

export interface AIResult {
  text: string;
  providerId: ProviderId;
  model: string;
}

/** Thrown for 429 / 5xx — the registry treats these as "try the next provider". */
export class RetriableProviderError extends Error {
  constructor(
    readonly providerId: ProviderId,
    readonly status: number,
    body: string,
  ) {
    super(`${providerId} returned ${status}: ${body.slice(0, 200)}`);
    this.name = "RetriableProviderError";
  }
}

export interface AIProvider {
  readonly id: ProviderId;
  run(req: AIRequest, model: string, apiKey: string): Promise<AIResult>;
}

/**
 * Thrown when the whole chain is exhausted. Carries `quotaExhausted` so the
 * orchestrator can tell "you are out of free-tier requests, wait a bit" —
 * which is a sentence — from "something is genuinely broken", which is not.
 */
export class AllProvidersFailed extends Error {
  constructor(
    readonly task: string,
    readonly failures: string[],
    readonly quotaExhausted: boolean,
  ) {
    super(`All providers failed for task ${task}:\n  ${failures.join("\n  ")}`);
    this.name = "AllProvidersFailed";
  }
}

/**
 * Every provider funnels its non-2xx handling through this so the
 * retriable/fatal split is identical across vendors.
 */
export async function raiseForStatus(
  providerId: ProviderId,
  res: Response,
): Promise<never> {
  const body = await res.text();
  // 429 and 5xx are retriable by status. An exhausted quota is retriable
  // whatever status the vendor chose to report it with.
  if (res.status === 429 || res.status >= 500 || isQuotaExhausted(body)) {
    throw new RetriableProviderError(providerId, res.status, body);
  }
  throw new Error(`${providerId} ${res.status}: ${body.slice(0, 300)}`);
}
