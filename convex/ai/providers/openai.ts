import type { AIProvider, AIRequest, AIResult } from "../types";
import { raiseForStatus } from "../types";
import { buildPrompt } from "../../lib/ai/prompt";

const BASE = "https://api.openai.com/v1";

/**
 * The Responses API rather than chat/completions: it takes the same shape for
 * reasoning models (o-series) and standard ones, so switching OPENAI_MODEL_*
 * between them stays an environment-variable edit. chat/completions would need
 * `max_completion_tokens` for o-series and `max_tokens` for the rest.
 */
export const openaiProvider: AIProvider = {
  id: "openai",

  async run(req: AIRequest, model: string, apiKey: string): Promise<AIResult> {
    const res = await fetch(`${BASE}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: req.system,
        input: buildPrompt(req.input, req.untrusted),
        max_output_tokens: req.maxOutputTokens ?? 1024,
      }),
    });

    if (!res.ok) await raiseForStatus("openai", res);

    const json = (await res.json()) as {
      output_text?: string;
      output?: { content?: { type?: string; text?: string }[] }[];
    };

    // `output_text` is the convenience field; fall back to walking `output`
    // because reasoning models emit a reasoning item before the message.
    const text =
      json.output_text?.trim() ||
      json.output
        ?.flatMap((item) => item.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("")
        .trim();

    if (!text) throw new Error("openai returned no text");

    return { text, providerId: "openai", model };
  },
};
