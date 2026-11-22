import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

const MAX_INTERESTS = 80;

/** Not yet expired, for ranking. The caller passes `nowMs`: queries stay deterministic. */
export const active = internalQuery({
  args: { userId: v.id("users"), nowMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("interests")
      .withIndex("by_user_topic", (q) => q.eq("userId", args.userId))
      .take(MAX_INTERESTS);
    return rows.filter((r) => r.expiresAt === undefined || r.expiresAt > args.nowMs);
  },
});

/** Everything, expired included, for "what am I interested in". */
export const listAll = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("interests")
      .withIndex("by_user_topic", (q) => q.eq("userId", args.userId))
      .take(MAX_INTERESTS),
});

/** Add or replace by topic (case-insensitive): saying it again renews it. */
export const add = internalMutation({
  args: {
    userId: v.id("users"),
    topic: v.string(),
    weight: v.number(),
    origin: v.string(),
    nowMs: v.number(),
    expiresAt: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    const topic = args.topic.trim().slice(0, 120).toLowerCase();
    if (!topic) return null;
    const existing = await ctx.db
      .query("interests")
      .withIndex("by_user_topic", (q) => q.eq("userId", args.userId).eq("topic", topic))
      .first();
    // An inferred nudge never overrides what the owner said in words.
    if (existing && existing.origin === "explicit" && args.origin === "inferred") return existing._id;
    const fields = {
      weight: args.weight,
      origin: args.origin,
      createdAt: args.nowMs,
      expiresAt: args.expiresAt,
      ...(args.embedding ? { embedding: args.embedding } : {}),
    };
    if (existing) {
      await ctx.db.patch("interests", existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("interests", { userId: args.userId, topic, ...fields });
  },
});

export const setEmbedding = internalMutation({
  args: { id: v.id("interests"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    if (await ctx.db.get("interests", args.id)) await ctx.db.patch("interests", args.id, { embedding: args.embedding });
  },
});

/** Remove by topic fragment. Returns the topics removed. */
export const remove = internalMutation({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const needle = args.fragment.trim().toLowerCase();
    if (!needle) return [];
    const rows = await ctx.db
      .query("interests")
      .withIndex("by_user_topic", (q) => q.eq("userId", args.userId))
      .take(MAX_INTERESTS);
    const hits = rows.filter((r) => r.topic.includes(needle));
    for (const r of hits) await ctx.db.delete("interests", r._id);
    return hits.map((r) => r.topic);
  },
});

/** Daily cleanup: expired interests carry no weight, so they go. */
export const purgeExpired = internalMutation({
  args: { userId: v.id("users"), nowMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("interests")
      .withIndex("by_user_topic", (q) => q.eq("userId", args.userId))
      .take(MAX_INTERESTS);
    const gone = rows.filter((r) => r.expiresAt !== undefined && r.expiresAt <= args.nowMs);
    for (const r of gone) await ctx.db.delete("interests", r._id);
    return gone.length;
  },
});
