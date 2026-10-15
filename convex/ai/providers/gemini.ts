import type { AIProvider, AIRequest, AIResult } from "../types";
import { raiseForStatus } from "../types";
import { buildPrompt } from "../../lib/ai/prompt";
import type { Tier } from "../../lib/ai/tiers";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The only place that knows Gemini's wire format. Plain `fetch`, so it runs in
 * the default V8 runtime — no `"use node"`, which would cost 512 MB against the
 * 20 GB-hour monthly budget instead of 64 MB.
 */

/**
 * Gemini 3.x models think before answering and bill those tokens against
 * maxOutputTokens. Measured on gemini-3.6-flash, 19 Aug 2026:
 *
 *   - A `maxOutputTokens` of 100 returns "The provider" — the answer was
 *     truncated because reasoning consumed the budget first.
 *   - `thinkingConfig` is a HINT, not a cap. `thinkingBudget: 0` is rejected
 *     outright (400 INVALID_ARGUMENT), and `thinkingLevel: "low"` still
 *     over-spends a 100-token ceiling.
 *
 * So the knob that actually works is headroom: the caller's maxOutputTokens is
 * the allowance for the ANSWER, and this reserve is added on top for thinking.
 * Getting this wrong does not error — it silently returns half a sentence.
 */
const THINKING_RESERVE: Record<Tier, number> = {
  CHEAP_STRUCTURED: 1024,
  REASON: 4096,
  DRAFT: 2048,
  TRANSCRIBE: 1024,
  // Reading text off a flyer or a carousel slide is transcription, not
  // analysis — the same shape as TRANSCRIBE, and it must not eat the answer
  // allowance on a multi-slide album.
  VISION: 1024,
  EMBED: 0,
};

/** "low" is still a real amount of thinking; only REASON needs more. */
const THINKING_LEVEL: Record<Tier, "low" | "high"> = {
  CHEAP_STRUCTURED: "low",
  REASON: "high",
  DRAFT: "low",
  TRANSCRIBE: "low",
  VISION: "low",
  EMBED: "low",
};

/**
 * Inline media caps the whole REQUEST at 20 MB, so this bounds the total
 * across every part, not each one. Telegram voice notes are Opus and tiny (a
 * minute is roughly 100 KB) and its photos are re-encoded JPEGs of a few
 * hundred KB, so a four-slide carousel is comfortably inside this; anything
 * approaching the cap is not what we think it is.
 */
const MAX_INLINE_MEDIA_BYTES = 15 * 1024 * 1024;

const DEFAULT_ANSWER_TOKENS = 1024;

/**
 * Audio rides in the same `parts` array as the prompt.
 *
 * Note which models are NOT usable for this. The dedicated audio models
 * (`gemini-2.5-flash-native-audio-*`, `gemini-3.1-flash-live-preview`,
 * `gemini-3.5-live-translate-preview`) expose `bidiGenerateContent` ONLY —
 * they are the Live API over websockets, not request/response, and cannot be
 * called from here. Transcription therefore uses an ordinary multimodal Flash
 * model, which is why the TRANSCRIBE ladder is the same as the REASON ladder.
 */
function buildParts(req: AIRequest): unknown[] {
  const parts: unknown[] = [{ text: buildPrompt(req.input, req.untrusted) }];
  if (!req.media || req.media.length === 0) return parts;

  // base64 inflates by 4/3; check DECODED size, summed across every part,
  // against the request-wide cap.
  const totalBytes = req.media.reduce(
    (sum, m) => sum + Math.floor((m.dataBase64.length * 3) / 4),
    0,
  );
  if (totalBytes > MAX_INLINE_MEDIA_BYTES) {
    throw new Error(
      `attached media is ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${
        MAX_INLINE_MEDIA_BYTES / 1024 / 1024
      } MB inline limit`,
    );
  }

  for (const m of req.media) {
    parts.push({ inlineData: { mimeType: m.mimeType, data: m.dataBase64 } });
  }

  return parts;
}

export const geminiProvider: AIProvider = {
  id: "gemini",

  async run(req: AIRequest, model: string, apiKey: string): Promise<AIResult> {
    const answerTokens = req.maxOutputTokens ?? DEFAULT_ANSWER_TOKENS;

    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header auth keeps the key out of URLs and logs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: buildParts(req) }],
        systemInstruction: { parts: [{ text: req.system }] },
        generationConfig: {
          maxOutputTokens: answerTokens + THINKING_RESERVE[req.tier],
          thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.tier] },
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });

    if (!res.ok) await raiseForStatus("gemini", res);

    const json = (await res.json()) as {
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string; thought?: boolean }[] };
      }[];
    };

    const candidate = json.candidates?.[0];

    // Gemini splits a response across parts; join rather than taking [0],
    // which silently truncates. Thought parts are reasoning, not the answer.
    const text = candidate?.content?.parts
      ?.filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) {
      // Distinguish "ran out of budget" from "refused" from "broken" — the
      // fix differs for each, and a bare "no text" hides all three.
      throw new Error(
        `gemini returned no text (finishReason: ${candidate?.finishReason ?? "unknown"})`,
      );
    }

    return { text, providerId: "gemini", model };
  },
};
