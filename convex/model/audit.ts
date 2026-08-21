import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * The only way anything enters auditLogs.
 *
 * There is deliberately NO delete function in this file and there never
 * will be. Convex gives you no SQL console, so the only way an audit row
 * can disappear is if someone writes the mutation. Do not write it.
 */
export const record = internalMutation({
  args: {
    actor: v.union(
      v.literal("user"),
      v.literal("system"),
      v.literal("scheduler"),
      v.literal("llm_proposed"),
    ),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    // schema.ts has had both of these on auditLogs since Phase 0, but this
    // validator never accepted them — Convex strips unvalidated args
    // silently, so every call that tried to set them lost them without
    // erroring. Phase 6 is the first code that genuinely needs approvalId:
    // "why did it send that?" is unanswerable without it (invariant I-5).
    accountId: v.optional(v.id("connectedAccounts")),
    approvalId: v.optional(v.id("approvals")),
    args: v.any(),
    result: v.union(v.literal("ok"), v.literal("denied"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("auditLogs", args);
  },
});
