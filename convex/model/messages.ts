import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

const REF = v.object({ kind: v.string(), id: v.string() });

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
    /** What the message is about — see schema.ts. */
    ref: v.optional(REF),
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

/** The message the user replied to (Telegram reply_to_message), if we sent it. */
export const findByChannelMessageId = internalQuery({
  args: { userId: v.id("users"), channelMessageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_user_channel_message", (q) =>
        q.eq("userId", args.userId).eq("channelMessageId", args.channelMessageId),
      )
      .first();
  },
});

/** Messages older than `beforeTime` and newer than `afterTime`, oldest first —
 *  the slice a conversation summary folds in. Bounded. */
export const between = internalQuery({
  args: {
    userId: v.id("users"),
    afterTime: v.number(),
    beforeTime: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_user", (q) =>
        q
          .eq("userId", args.userId)
          .gt("_creationTime", args.afterTime)
          .lt("_creationTime", args.beforeTime),
      )
      .order("asc")
      .take(Math.min(args.limit, 100));
  },
});

export const getSummary = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversationSummaries")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const saveSummary = internalMutation({
  args: { userId: v.id("users"), summary: v.string(), coveredThrough: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversationSummaries")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const row = { summary: args.summary, coveredThrough: args.coveredThrough, updatedAt: Date.now() };
    if (existing) {
      // Never move backwards: two overlapping summarize runs must not let the
      // older one overwrite the newer one.
      if (existing.coveredThrough >= args.coveredThrough) return;
      await ctx.db.patch("conversationSummaries", existing._id, row);
      return;
    }
    await ctx.db.insert("conversationSummaries", { userId: args.userId, ...row });
  },
});

/** Check-then-insert inside one mutation: true when this nudge is new. */
export const claimNudge = internalMutation({
  args: { userId: v.id("users"), key: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("calendarNudges")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", args.key))
      .first();
    if (existing) return false;
    await ctx.db.insert("calendarNudges", { ...args, sentAt: Date.now() });
    return true;
  },
});
