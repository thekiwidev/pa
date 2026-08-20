import { internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";

/**
 * Every mutation here re-reads the task and checks its `userId` against the
 * caller's. The task id arrives from the model, which read it out of a
 * task.list result — an id is a proposal like any other and is never trusted
 * to imply ownership.
 */
async function ownedTask(ctx: MutationCtx, userId: Id<"users">, taskId: string) {
  // normalizeId returns null for a string that is not an id for this table,
  // which is exactly what a hallucinated id looks like.
  const id = ctx.db.normalizeId("tasks", taskId);
  if (id === null) throw new Error(`No such task: ${taskId}`);

  const task = await ctx.db.get("tasks", id);
  if (!task || task.userId !== userId) throw new Error(`No such task: ${taskId}`);
  return task;
}

export const create = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    detail: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
    priority: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const taskId = await ctx.db.insert("tasks", {
      userId: args.userId,
      projectId: args.projectId,
      title: args.title,
      detail: args.detail,
      status: "PLANNED",
      priority: args.priority ?? 3,
      dueAt: args.dueAt,
      sourceType: "telegram",
    });
    return { taskId };
  },
});

export const list = internalQuery({
  args: {
    userId: v.id("users"),
    status: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit, 25);

    if (args.status !== undefined) {
      const status = args.status;
      return await ctx.db
        .query("tasks")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", args.userId).eq("status", status),
        )
        .take(limit);
    }

    return await ctx.db
      .query("tasks")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId))
      .take(limit);
  },
});

export const update = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.string(),
    title: v.optional(v.string()),
    detail: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.number()),
    dueAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = await ownedTask(ctx, args.userId, args.taskId);
    await ctx.db.patch("tasks", task._id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}),
    });
    return { taskId: task._id };
  },
});

export const complete = internalMutation({
  args: { userId: v.id("users"), taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await ownedTask(ctx, args.userId, args.taskId);
    await ctx.db.patch("tasks", task._id, { status: "COMPLETED" });
    return { taskId: task._id, title: task.title };
  },
});

/**
 * BLOCKED plus a blocker row. The blocker is a separate table rather than a
 * field because a task can be waiting on more than one thing, and because
 * Phase 13's state machine needs the history.
 */
export const block = internalMutation({
  args: {
    userId: v.id("users"),
    taskId: v.string(),
    description: v.string(),
    waitingOn: v.optional(v.id("people")),
    expectedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = await ownedTask(ctx, args.userId, args.taskId);

    const blockerId = await ctx.db.insert("blockers", {
      taskId: task._id,
      description: args.description,
      waitingOn: args.waitingOn,
      expectedAt: args.expectedAt,
    });

    await ctx.db.patch("tasks", task._id, { status: "BLOCKED" });
    return { taskId: task._id, blockerId };
  },
});

export const unblock = internalMutation({
  args: { userId: v.id("users"), taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await ownedTask(ctx, args.userId, args.taskId);

    const open = await ctx.db
      .query("blockers")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(25);

    const now = Date.now();
    for (const blocker of open) {
      if (blocker.resolvedAt === undefined) {
        await ctx.db.patch("blockers", blocker._id, { resolvedAt: now });
      }
    }

    await ctx.db.patch("tasks", task._id, { status: "RESUMED" });
    return { taskId: task._id, resolved: open.length };
  },
});

/** Open blockers across a user's tasks — the "what am I waiting on" query. */
export const openBlockers = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const blocked = await ctx.db
      .query("tasks")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", args.userId).eq("status", "BLOCKED"),
      )
      .take(25);

    const out = [];
    for (const task of blocked) {
      const blockers = await ctx.db
        .query("blockers")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .take(10);
      out.push({
        task,
        blockers: blockers.filter((b) => b.resolvedAt === undefined),
      });
    }
    return out;
  },
});

/**
 * Resolve a task by title within a user, newest first.
 *
 * The model cannot know the id of a task it is creating in the same plan, so
 * "test the server, and I'm blocked on Dash" has to address the new task by
 * name. Resolution happens HERE, in code — the model still never supplies a
 * foreign key it invented.
 */
export const findByTitle = internalQuery({
  args: { userId: v.id("users"), title: v.string() },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("tasks")
      .withIndex("by_user_status", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(100);

    const wanted = args.title.trim().toLowerCase();
    const open = candidates.filter(
      (t) => t.status !== "COMPLETED" && t.status !== "CANCELLED",
    );

    // Exact first, then containment either way, preferring open tasks.
    for (const pool of [open, candidates]) {
      const exact = pool.find((t) => t.title.trim().toLowerCase() === wanted);
      if (exact) return exact;
    }
    for (const pool of [open, candidates]) {
      const loose = pool.find((t) => {
        const title = t.title.trim().toLowerCase();
        return title.includes(wanted) || wanted.includes(title);
      });
      if (loose) return loose;
    }
    return null;
  },
});
