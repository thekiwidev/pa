// Text embeddings for saved posts (the EMBED tier, Phase 17's slot).
//
// One provider embeds, chosen by `embedProvider` (Gemini when its key is set:
// gemini-embedding-001 is on the free tier). Both providers emit 768-d
// vectors, so the index accepts either, but the spaces are unrelated: there
// is no cross-provider fallback, and switching provider means re-embedding.

import { DEFAULT_EMBED_MODEL, embedProvider } from "../lib/ai/routes";
import { modelChain } from "../lib/ai/tiers";
import { normalizeVector } from "../lib/saved/rank";

export const EMBED_DIMENSIONS = 768;

export type EmbedPurpose = "document" | "query";

async function geminiEmbed(apiKey: string, model: string, texts: string[], purpose: EmbedPurpose): Promise<number[][]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBED_DIMENSIONS,
          taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
  return (json.embeddings ?? []).map((e) => normalizeVector(e.values ?? []));
}

async function openaiEmbed(apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts, dimensions: EMBED_DIMENSIONS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`openai embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: { embedding?: number[] }[] };
  return (json.data ?? []).map((d) => normalizeVector(d.embedding ?? []));
}

/** True when some provider can embed. Everything degrades to text search when not. */
export function canEmbed(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

/**
 * Embed texts with the one embedding provider. Returns null rather
 * than throwing: a missing vector costs meaning-search for one item, and
 * must never cost the save itself.
 */
export async function embedTexts(texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const provider = embedProvider(process.env);
  if (!provider) return null;
  const model = modelChain(provider, "EMBED", process.env)[0] ?? DEFAULT_EMBED_MODEL[provider];
  try {
    const vectors =
      provider === "gemini"
        ? await geminiEmbed(process.env.GEMINI_API_KEY ?? "", model, texts, purpose)
        : await openaiEmbed(process.env.OPENAI_API_KEY ?? "", model, texts);
    if (vectors.length === texts.length && vectors.every((v) => v.length === EMBED_DIMENSIONS)) return vectors;
  } catch (error) {
    console.warn(`embed_failed provider=${provider}: ${String(error).slice(0, 200)}`);
  }
  return null;
}
