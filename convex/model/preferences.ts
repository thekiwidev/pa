import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/** Typed key/value: working hours, tone, notification thresholds. */
export const set = internalMutation({
  args: { userId: v.id("users"), key: v.string(), value: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", args.userId).eq("key", args.key),
      )
      .unique();

    if (existing) {
      await ctx.db.patch("preferences", existing._id, { value: args.value });
      return existing._id;
    }
    return await ctx.db.insert("preferences", args);
  },
});

export const all = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId))
      .take(50);
  },
});

/** One key's value, or null when it was never set. */
export const get = internalQuery({
  args: { userId: v.id("users"), key: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", args.userId).eq("key", args.key),
      )
      .unique();
    return row?.value ?? null;
  },
});
