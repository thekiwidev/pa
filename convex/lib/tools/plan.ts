// Pure. Turns the model's raw text into a validated plan.
//
// This is invariant I-1 in code: the model PROPOSES a typed tool call, and
// nothing here executes anything. Every argument is Zod-validated before the
// router in convex/tools/router.ts will look at it, and a proposal naming an
// unknown tool is dropped rather than guessed at.
import { TOOL_SCHEMAS, isToolName, type ToolName } from "./catalog";
import { parseJsonObject } from "../json";

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
  /** The E-label of the email the reply is about ("E2"), when it names one. */
  focus?: string;
  /** The one next step the reply proposes, for the Do it now / Later buttons. */
  next?: string;
}

/** Long enough for a real step, short enough to sit in a preference row. */
export const NEXT_STEP_MAX = 160;

export function parseToolPlan(raw: string): ToolPlan {
  // Fence-stripping, the balanced object scan and the doubled-brace retry all
  // live in lib/json.ts — shared with lib/email/draftBody.ts, which faces the
  // identical set of model quirks.
  const parsed = parseJsonObject(raw);
  if (parsed === null) return { reply: raw.trim(), calls: [], rejected: [] };

  const obj = parsed as { reply?: unknown; tools?: unknown; focus?: unknown; next?: unknown };
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  const focus =
    typeof obj.focus === "string" && /^E\d+$/i.test(obj.focus.trim())
      ? obj.focus.trim().toUpperCase()
      : undefined;

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

  const next =
    typeof obj.next === "string" && obj.next.trim()
      ? obj.next.trim().replace(/\s+/g, " ").slice(0, NEXT_STEP_MAX)
      : undefined;

  return {
    reply,
    calls,
    rejected,
    ...(focus ? { focus } : {}),
    ...(next ? { next } : {}),
  };
}
