import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

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
