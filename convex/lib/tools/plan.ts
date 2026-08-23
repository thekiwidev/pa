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
}

export function parseToolPlan(raw: string): ToolPlan {
  // Fence-stripping, the balanced object scan and the doubled-brace retry all
  // live in lib/json.ts — shared with lib/email/draftBody.ts, which faces the
  // identical set of model quirks.
  const parsed = parseJsonObject(raw);
  if (parsed === null) return { reply: raw.trim(), calls: [], rejected: [] };

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
