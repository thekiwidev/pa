import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { NOTIFY_PREF_KEY } from "../lib/notify/policy";

/**
 * Find the user by Telegram ID, creating them on first contact.
 * The owner-only guard in convex/http.ts runs BEFORE this, so anyone
 * reaching here is already authorized.
 *
 * `.withIndex(...)`, never `.filter(...)`. Convex caps a transaction at
 * 32,000 documents scanned — a filter over a growing table throws once real
 * data arrives.
 */
export const ensureByTelegramId = internalMutation({
  args: { telegramId: v.string(), displayName: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_telegram", (q) => q.eq("telegramId", args.telegramId))
      .unique();

    if (existing) return existing._id;

    return await ctx.db.insert("users", {
      telegramId: args.telegramId,
      displayName: args.displayName,
      timezone: process.env.USER_TIMEZONE ?? "Africa/Lagos",
    });
  },
});

export const getByTelegramId = internalQuery({
  args: { telegramId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_telegram", (q) => q.eq("telegramId", args.telegramId))
      .unique();
  },
});

export const get = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await ctx.db.get("users", args.userId),
});

/** A button tap is activity too: it keeps the attention policy out of auto-quiet. */
export const touch = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastInboundAt: Date.now() });
  },
});

/** Everything the attention policy needs, in one read. */
export const attention = internalQuery({
  args: { userId: v.id("users"), legacyKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.userId);
    const legacyKey = args.legacyKey;
    const legacy = legacyKey
      ? await ctx.db
          .query("preferences")
          .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", legacyKey))
          .unique()
      : null;
    const notify = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", NOTIFY_PREF_KEY))
      .unique();
    return { lastInboundAt: user?.lastInboundAt, notify: notify?.value ?? null, legacyRaw: legacy?.value ?? null };
  },
});
