import type { AIProvider, AIRequest, AIResult } from "../types";
import { raiseForStatus } from "../types";
import { buildPrompt, withJsonReminder } from "../../lib/ai/prompt";

const BASE = "https://api.openai.com/v1";

/**
 * The Responses API rather than chat/completions: it takes the same shape for
 * reasoning models (o-series) and standard ones, so switching OPENAI_MODEL_*
 * between them stays an environment-variable edit. chat/completions would need
 * `max_completion_tokens` for o-series and `max_tokens` for the rest.
 */
/**
 * A plain string when there is no media, the structured content-part form
 * when there is.
 *
 * Media was silently DROPPED here until 2026-08-23 while resolve.ts claimed
 * this provider supported TRANSCRIBE — so a voice note routed to OpenAI got a
 * confident answer to an empty prompt. Images and PDFs are implemented below;
 * the TRANSCRIBE claim was removed instead, because /v1/responses has no
 * audio input part and pretending otherwise is what caused the bug.
 */
function buildInput(req: AIRequest): unknown {
  const prompt = withJsonReminder(buildPrompt(req.input, req.untrusted), req.json);
  const media = (req.media ?? []).filter((m) => !m.mimeType.startsWith("audio/"));
  if (media.length === 0) return prompt;

  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...media.map((m) =>
          m.mimeType === "application/pdf"
            ? {
                type: "input_file",
                filename: "document.pdf",
                file_data: `data:${m.mimeType};base64,${m.dataBase64}`,
              }
            : {
                type: "input_image",
                image_url: `data:${m.mimeType};base64,${m.dataBase64}`,
              },
        ),
      ],
    },
  ];
}

/**
 * GPT-5 and o-series models reason before answering, and that reasoning is
 * billed against `max_output_tokens`. Without headroom a planner asked for
 * 1,500 tokens can spend all of them thinking and return nothing — the same
 * trap MEMORY.md records for Gemini 3.x. Effort is pinned low: the planner
 * picks tools from a list, it does not need to deliberate.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

const REASONING_RESERVE = 2048;

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
        input: buildInput(req),
        max_output_tokens:
          (req.maxOutputTokens ?? 1024) + (isReasoningModel(model) ? REASONING_RESERVE : 0),
        ...(isReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
        // json_object requires the word "json" in the INPUT, not in
        // instructions; buildInput guarantees it via withJsonReminder.
        ...(req.json ? { text: { format: { type: "json_object" } } } : {}),
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
