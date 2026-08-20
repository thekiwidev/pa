import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/** The only writes to the `messages` table. Actions cannot write to the
 *  database, so the orchestrator calls these. */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    channel: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    channelMessageId: v.optional(v.string()),
    kind: v.string(),
    text: v.optional(v.string()),
    // Phase 9: for voice, `text` is the transcript used downstream and
    // `transcript` is the same string kept as provenance — what the model
    // actually heard, so a wrong answer can be traced to a mishearing.
    transcript: v.optional(v.string()),
    transcriptConfidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", args);
  },
});

/**
 * The last `limit` messages for a user, oldest-first — the conversation
 * window the orchestrator feeds to the model.
 *
 * `by_user` is indexed on ["userId"] and Convex appends _creationTime as the
 * final index column, so .order("desc") gives newest-first without a sort.
 */
export const recentForUser = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    const newestFirst = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(Math.min(args.limit, 50));

    return newestFirst.reverse();
  },
});
