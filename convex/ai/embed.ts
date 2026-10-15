// Text embeddings for saved posts (the EMBED tier, Phase 17's slot).
//
// Gemini first: gemini-embedding-001 has a free tier and supports 768
// output dimensions, which is what the vector indexes declare. OpenAI's
// text-embedding-3-small takes `dimensions: 768` too, so either can fill the
// same index. Switching provider later means re-embedding, not migrating.

import { resolveProviderChain } from "../lib/ai/resolve";
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

const DEFAULT_MODEL: Record<string, string> = {
  gemini: "gemini-embedding-001",
  openai: "text-embedding-3-small",
};

/** True when some provider can embed. Everything degrades to text search when not. */
export function canEmbed(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

/**
 * Embed texts, trying providers in EMBED-tier order. Returns null rather
 * than throwing: a missing vector costs meaning-search for one item, and
 * must never cost the save itself.
 */
export async function embedTexts(texts: string[], purpose: EmbedPurpose): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  let chain: string[];
  try {
    chain = resolveProviderChain(process.env, "EMBED", "EMBED_TEXT").filter((p) => p === "gemini" || p === "openai");
  } catch {
    return null;
  }
  for (const provider of chain) {
    const model = modelChain(provider, "EMBED", process.env)[0] ?? DEFAULT_MODEL[provider];
    try {
      const vectors =
        provider === "gemini"
          ? await geminiEmbed(process.env.GEMINI_API_KEY ?? "", model!, texts, purpose)
          : await openaiEmbed(process.env.OPENAI_API_KEY ?? "", model!, texts);
      if (vectors.length === texts.length && vectors.every((v) => v.length === EMBED_DIMENSIONS)) return vectors;
    } catch (error) {
      console.warn(`embed_failed provider=${provider}: ${String(error).slice(0, 200)}`);
    }
  }
  return null;
}
