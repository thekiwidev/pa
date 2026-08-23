import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * A carousel is rarely more than ten slides and Telegram caps an album at
 * ten. The bound also keeps the inline-media request inside the provider's
 * per-request size cap.
 */
const MAX_SLIDES = 10;

export const addSlide = internalMutation({
  args: {
    userId: v.id("users"),
    mediaGroupId: v.string(),
    chatId: v.string(),
    fileId: v.string(),
    caption: v.string(),
    channelMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mediaGroups")
      .withIndex("by_group", (q) => q.eq("mediaGroupId", args.mediaGroupId))
      .take(MAX_SLIDES + 1);

    // Over the cap: keep what we have rather than growing the request past
    // what the provider will accept.
    if (existing.length > MAX_SLIDES) return { slideCount: existing.length, isFirst: false };

    await ctx.db.insert("mediaGroups", {
      userId: args.userId,
      mediaGroupId: args.mediaGroupId,
      chatId: args.chatId,
      fileId: args.fileId,
      caption: args.caption,
      channelMessageId: args.channelMessageId,
      receivedAt: Date.now(),
    });

    // Only the FIRST slide schedules the flush. Check-then-insert inside one
    // transaction, the same pattern used wherever this project needs
    // uniqueness without a UNIQUE constraint.
    return { slideCount: existing.length + 1, isFirst: existing.length === 0 };
  },
});

export const recordFlushJob = internalMutation({
  args: { mediaGroupId: v.string(), flushJobId: v.id("_scheduled_functions") },
  handler: async (ctx, args) => {
    const first = await ctx.db
      .query("mediaGroups")
      .withIndex("by_group", (q) => q.eq("mediaGroupId", args.mediaGroupId))
      .first();
    if (first) await ctx.db.patch(first._id, { flushJobId: args.flushJobId });
  },
});

export const list = internalQuery({
  args: { mediaGroupId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mediaGroups")
      .withIndex("by_group", (q) => q.eq("mediaGroupId", args.mediaGroupId))
      .take(MAX_SLIDES);
    // Telegram delivers slides in order but not necessarily in order of
    // arrival, so sort by the message id the user's client assigned.
    return rows.sort((a, b) => Number(a.channelMessageId) - Number(b.channelMessageId));
  },
});

/** Called after the slides have been read. Nothing reads an unflushed group,
 *  so a failure to reach here leaks rows but changes no behaviour. */
export const clear = internalMutation({
  args: { mediaGroupId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mediaGroups")
      .withIndex("by_group", (q) => q.eq("mediaGroupId", args.mediaGroupId))
      .take(MAX_SLIDES);
    for (const r of rows) await ctx.db.delete(r._id);
  },
});
