// Pure. Turns the model's raw text into a validated plan.
//
// This is invariant I-1 in code: the model PROPOSES a typed tool call, and
// nothing here executes anything. Every argument is Zod-validated before the
// router in convex/tools/router.ts will look at it, and a proposal naming an
// unknown tool is dropped rather than guessed at.
import { TOOL_SCHEMAS, isToolName, type ToolName } from "./catalog";

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface RejectedCall {
  name: string;
  reason: string;
}

export interface ToolPlan {
  reply: string;
  calls: ToolCall[];
  rejected: RejectedCall[];
}

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/**
 * Models wrap JSON in fences, prepend prose, or return prose only. Recover the
 * JSON object if there is one; otherwise treat the whole output as the reply.
 */
function extractJsonObject(raw: string): string | null {
  const fenced = FENCE.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  // Balanced scan, string-aware, so a brace inside a reply string does not
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
 *  unwrap, so the caller can fall through to treating the output as prose. */
function unwrapDoubledBraces(json: string): string | null {
  const trimmed = json.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return null;
  return trimmed.slice(1, -1);
}

export function parseToolPlan(raw: string): ToolPlan {
  const json = extractJsonObject(raw);
  if (json === null) return { reply: raw.trim(), calls: [], rejected: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Observed live: the model sometimes emits {{ "reply": ... }} — doubled
    // braces, probably template-syntax bleed. The balanced scan above happily
    // returns that whole string, JSON.parse rejects it, and the fallback
    // treats the raw JSON as prose — so the user sees the tool call printed
    // at them and NOTHING executes. Strip one symmetric layer and retry.
    const unwrapped = unwrapDoubledBraces(json);
    if (unwrapped === null) return { reply: raw.trim(), calls: [], rejected: [] };
    try {
      parsed = JSON.parse(unwrapped);
    } catch {
      return { reply: raw.trim(), calls: [], rejected: [] };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { reply: raw.trim(), calls: [], rejected: [] };
  }

  const obj = parsed as { reply?: unknown; tools?: unknown };
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";

  const calls: ToolCall[] = [];
  const rejected: RejectedCall[] = [];

  if (Array.isArray(obj.tools)) {
    for (const entry of obj.tools) {
      if (typeof entry !== "object" || entry === null) {
        rejected.push({ name: "(malformed)", reason: "not an object" });
        continue;
      }

      const { name, args } = entry as { name?: unknown; args?: unknown };

      if (typeof name !== "string" || !isToolName(name)) {
        rejected.push({ name: String(name), reason: "unknown tool" });
        continue;
      }

      const result = TOOL_SCHEMAS[name].safeParse(args ?? {});
      if (!result.success) {
        rejected.push({
          name,
          reason: result.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        });
        continue;
      }

      calls.push({ name, args: result.data as Record<string, unknown> });
    }
  }

  return { reply, calls, rejected };
}
