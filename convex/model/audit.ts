import { internalMutation, internalQuery } from "../_generated/server";
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

/**
 * Recent web search audit rows: "web.search" (one per call, for the daily cap)
 * and "web.search.results" (the result urls, written by the tool itself) (the only urls web.read may open that the owner did not
 * type). A read, so the append-only rule is untouched.
 */
export const recentSearches = internalQuery({
  args: { action: v.union(v.literal("web.search"), v.literal("web.search.results")), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("auditLogs")
      .withIndex("by_action", (q) => q.eq("action", args.action))
      .order("desc")
      .take(Math.min(args.limit, 200));
    return rows.map((r) => ({
      at: r._creationTime,
      urls: Array.isArray((r.args as { urls?: unknown })?.urls)
        ? ((r.args as { urls: unknown[] }).urls.filter((u): u is string => typeof u === "string"))
        : [],
    }));
  },
});
