import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Convex has no UNIQUE constraint. Uniqueness of (userId, name) is enforced by
 * the by_user_name index plus check-then-insert inside one mutation, which is
 * a transaction.
 */
export const upsert = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    status: v.optional(v.string()),
    objective: v.optional(v.string()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", args.userId).eq("name", args.name),
      )
      .unique();

    if (existing) {
      await ctx.db.patch("projects", existing._id, {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.objective !== undefined ? { objective: args.objective } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
      });
      return { projectId: existing._id, created: false };
    }

    const projectId = await ctx.db.insert("projects", {
      userId: args.userId,
      name: args.name,
      status: args.status ?? "ACTIVE",
      objective: args.objective,
      priority: args.priority ?? 3,
    });
    return { projectId, created: true };
  },
});

export const getByName = internalQuery({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", args.userId).eq("name", args.name),
      )
      .unique();

    if (!project) return null;

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(25);

    return { project, tasks };
  },
});

export const listActive = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId))
      .take(Math.min(args.limit, 25));
  },
});
