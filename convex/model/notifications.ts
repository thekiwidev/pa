import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Three replies on one thread inside this window update ONE card instead of
 * posting three. Freshness is checked by the CALLER (an action), never here —
 * a query must never read the wall clock, because a query is not re-run just
 * because time passes, so a time-derived result inside one would silently go
 * stale.
 */
export const DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** The most recent notification for a thread, or null. Staleness is the
 *  caller's job — see DEDUP_WINDOW_MS above. */
export const findByThreadKey = internalQuery({
  args: { threadKey: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_thread_key", (q) => q.eq("threadKey", args.threadKey))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

/** A brand-new card. `channelMessageId` is what `editCard` needs the next
 *  time this thread gets a reply. */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    channel: v.string(),
    emailMessageId: v.optional(v.id("emailMessages")),
    threadKey: v.optional(v.string()),
    channelMessageId: v.optional(v.string()),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const notificationId = await ctx.db.insert("notifications", {
      ...args,
      sentAt: Date.now(),
    });
    return { notificationId };
  },
});

/** The existing card got new content — bump `sentAt` too, so a further reply
 *  inside the window keeps editing the same message rather than reverting to
 *  "stale, post a new one" right after this one refreshed it. */
export const updateChannelMessageId = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    channelMessageId: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("notifications", args.notificationId, {
      channelMessageId: args.channelMessageId,
      payload: args.payload,
      sentAt: Date.now(),
    });
  },
});
