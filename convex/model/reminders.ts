import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

/**
 * Exact-time delivery. The v2 design polled a table from a cron tick; Convex
 * schedules the actual function at the actual instant, so there is no scan, no
 * ten-minute granularity, and no double-fire from two overlapping ticks.
 *
 * The returned job id is stored on the row — cancel, reschedule, and Phase
 * 18's cooling-off [ Stop ] button all need it.
 */
export const create = internalMutation({
  args: {
    userId: v.id("users"),
    message: v.string(),
    scheduledAt: v.number(),
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const reminderId = await ctx.db.insert("reminders", {
      userId: args.userId,
      message: args.message,
      scheduledAt: args.scheduledAt,
      status: "PENDING",
      taskId: args.taskId,
      projectId: args.projectId,
    });

    const jobId = await ctx.scheduler.runAt(
      args.scheduledAt,
      internal.reminders.deliver,
      { reminderId },
    );

    await ctx.db.patch("reminders", reminderId, { scheduledJobId: jobId });
    return { reminderId, scheduledAt: args.scheduledAt };
  },
});

export const listPending = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("reminders")
      .withIndex("by_status_scheduled", (q) => q.eq("status", "PENDING"))
      .take(50);

    return pending.filter((r) => r.userId === args.userId);
  },
});

export const cancel = internalMutation({
  args: { userId: v.id("users"), reminderId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("reminders", args.reminderId);
    if (id === null) throw new Error(`No such reminder: ${args.reminderId}`);

    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.userId !== args.userId) {
      throw new Error(`No such reminder: ${args.reminderId}`);
    }
    if (reminder.status !== "PENDING") {
      return { reminderId: id, cancelled: false, reason: reminder.status };
    }

    // Cancel the scheduled job itself, rather than flipping a status column
    // and hoping the next scan honours it.
    if (reminder.scheduledJobId) await ctx.scheduler.cancel(reminder.scheduledJobId);

    await ctx.db.patch("reminders", id, { status: "CANCELLED" });
    return { reminderId: id, cancelled: true };
  },
});

/** Read by the delivery action, which has no ctx.db of its own. */
export const forDelivery = internalQuery({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    const reminder = await ctx.db.get("reminders", args.reminderId);
    if (!reminder) return null;

    const user = await ctx.db.get("users", reminder.userId);
    if (!user) return null;

    return { reminder, telegramId: user.telegramId };
  },
});

export const markSent = internalMutation({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    await ctx.db.patch("reminders", args.reminderId, {
      status: "SENT",
      sentAt: Date.now(),
    });
  },
});

/**
 * PENDING rows whose time has passed. If the scheduler did its job this
 * returns nothing — it catches OUR bugs (a reminder written without its
 * runAt, a job cancelled by mistake), which is the difference between
 * "usually reminds you" and "reminds you".
 */
export const findMissed = internalQuery({
  args: { before: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reminders")
      .withIndex("by_status_scheduled", (q) =>
        q.eq("status", "PENDING").lt("scheduledAt", args.before),
      )
      .take(25);
  },
});
