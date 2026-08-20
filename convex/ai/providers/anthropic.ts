import type { AIProvider, AIRequest, AIResult } from "../types";
import { raiseForStatus } from "../types";
import { buildPrompt } from "../../lib/ai/prompt";

const BASE = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

/**
 * Anthropic covers CHEAP_STRUCTURED / REASON / DRAFT only — no audio, no
 * embeddings. That is declared in PROVIDER_CAPABILITIES, so a TRANSCRIBE task
 * never reaches this file.
 */
export const anthropicProvider: AIProvider = {
  id: "anthropic",

  async run(req: AIRequest, model: string, apiKey: string): Promise<AIResult> {
    const res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model,
        system: req.system,
        // max_tokens is required by this API, not optional.
        max_tokens: req.maxOutputTokens ?? 1024,
        messages: [
          { role: "user", content: buildPrompt(req.input, req.untrusted) },
        ],
      }),
    });

    if (!res.ok) await raiseForStatus("anthropic", res);

    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = json.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    if (!text) throw new Error("anthropic returned no text");

    return { text, providerId: "anthropic", model };
  },
};
