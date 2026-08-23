// Pure. Recovering a JSON object from a model completion.
//
// Extracted from lib/tools/plan.ts when a second caller appeared
// (lib/email/draftBody.ts). Both face the identical problem: a model asked for
// JSON will sometimes fence it, prepend prose, or double its braces, and each
// of those has cost this project a live bug. One implementation, one set of
// tests.

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Models wrap JSON in fences, prepend prose, or return prose only. Recover the
 * JSON object if there is one; otherwise return null so the caller can decide
 * what a prose-only completion means for it.
 */
export function extractJsonObject(raw: string): string | null {
  const fenced = FENCE.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  // Balanced scan, string-aware, so a brace inside a string value does not
  // truncate the object.
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** `{{ ... }}` -> `{ ... }`, once. Returns null when there is nothing to
 *  unwrap, so the caller can fall through to its own prose handling. */
export function unwrapDoubledBraces(json: string): string | null {
  const trimmed = json.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return null;
  return trimmed.slice(1, -1);
}

/**
 * The full recovery ladder: extract, parse, and on a parse failure strip one
 * symmetric brace layer and retry.
 *
 * Observed live: the model sometimes emits `{{ "reply": ... }}` — doubled
 * braces, probably template-syntax bleed. The balanced scan happily returns
 * that whole string and JSON.parse rejects it.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const json = extractJsonObject(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    const unwrapped = unwrapDoubledBraces(json);
    if (unwrapped === null) return null;
    try {
      parsed = JSON.parse(unwrapped);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
