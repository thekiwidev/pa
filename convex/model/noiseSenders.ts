import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Convex has no UNIQUE constraint: check the index, then insert, inside one
 * mutation — the same check-then-insert pattern as every other upsert in
 * this codebase (see emailMessages.upsert).
 */
export const add = internalMutation({
  args: { userId: v.id("users"), pattern: v.string() },
  handler: async (ctx, args) => {
    const normalized = args.pattern.trim().toLowerCase();
    const existing = await ctx.db
      .query("noiseSenders")
      .withIndex("by_user_pattern", (q) => q.eq("userId", args.userId).eq("pattern", normalized))
      .unique();
    if (existing) return { noiseSenderId: existing._id, created: false };

    const noiseSenderId = await ctx.db.insert("noiseSenders", {
      userId: args.userId,
      pattern: normalized,
    });
    return { noiseSenderId, created: true };
  },
});

export const remove = internalMutation({
  args: { userId: v.id("users"), pattern: v.string() },
  handler: async (ctx, args) => {
    const normalized = args.pattern.trim().toLowerCase();
    const existing = await ctx.db
      .query("noiseSenders")
      .withIndex("by_user_pattern", (q) => q.eq("userId", args.userId).eq("pattern", normalized))
      .unique();
    if (!existing) return { removed: false };

    await ctx.db.delete("noiseSenders", existing._id);
    return { removed: true };
  },
});

export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("noiseSenders")
      .withIndex("by_user_pattern", (q) => q.eq("userId", args.userId))
      .take(500);
  },
});

/**
 * Bounded scan, same style as emailMessages.search — this table is edited by
 * hand (Phase 5's [ Not important ] button) and stays small at personal
 * volume, so a full per-user scan on every sync is cheap.
 */
export const matches = internalQuery({
  args: { userId: v.id("users"), fromAddress: v.string() },
  handler: async (ctx, args) => {
    const address = args.fromAddress.trim().toLowerCase();
    const domain = address.split("@")[1];
    const rows = await ctx.db
      .query("noiseSenders")
      .withIndex("by_user_pattern", (q) => q.eq("userId", args.userId))
      .take(500);
    return rows.some((r) => r.pattern === address || (domain !== undefined && r.pattern === domain));
  },
});
