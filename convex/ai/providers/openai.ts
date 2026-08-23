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
  const prompt = buildPrompt(req.input, req.untrusted);
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
