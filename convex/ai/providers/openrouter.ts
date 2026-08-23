import type { AIProvider, AIRequest, AIResult } from "../types";
import { raiseForStatus } from "../types";
import { buildPrompt } from "../../lib/ai/prompt";

const BASE = "https://openrouter.ai/api/v1";

/**
 * OpenRouter fronts hundreds of models behind ONE key, in OpenAI's older
 * chat/completions shape — not the newer Responses API the openai.ts
 * provider uses, and not compatible with it. This is its own thin client for
 * that reason, not a config toggle on the OpenAI provider.
 *
 * Model names are OpenRouter's own, "vendor/model" — e.g.
 * "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-exp:free",
 * "meta-llama/llama-3.3-70b-instruct". Whatever you put in
 * OPENROUTER_MODEL_<TIER> is passed straight through; OpenRouter itself
 * decides whether that model exists and what it can do (e.g. audio input for
 * TRANSCRIBE) — this file makes no assumption about capability per model.
 */
export const openrouterProvider: AIProvider = {
  id: "openrouter",

  async run(req: AIRequest, model: string, apiKey: string): Promise<AIResult> {
    const content: unknown[] = [{ type: "text", text: buildPrompt(req.input, req.untrusted) }];

    // Chat-completions multimodal shape. Audio and images use DIFFERENT
    // part types here (unlike Gemini's single inlineData envelope), so the
    // mime type decides which. Only sent when media is actually attached, so
    // a text-only model never sees a malformed part.
    for (const m of req.media ?? []) {
      if (m.mimeType.startsWith("audio/")) {
        content.push({
          type: "input_audio",
          input_audio: { data: m.dataBase64, format: m.mimeType.split("/")[1] ?? "ogg" },
        });
      } else {
        // Images and PDFs both ride as a data: URL in an image_url part.
        content.push({
          type: "image_url",
          image_url: { url: `data:${m.mimeType};base64,${m.dataBase64}` },
        });
      }
    }

    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Both optional per OpenRouter's docs, but required for a listing on
        // openrouter.ai/rankings and for their own abuse-contact process —
        // costs nothing to set correctly from the start.
        "HTTP-Referer": "https://github.com/thekiwidev/personal-ai-assistant",
        "X-Title": "Personal AI Assistant",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content },
        ],
        max_tokens: req.maxOutputTokens ?? 1024,
      }),
    });

    if (!res.ok) await raiseForStatus("openrouter", res);

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();

    if (!text) throw new Error("openrouter returned no text");

    return { text, providerId: "openrouter", model };
  },
};
