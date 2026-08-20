import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendMessage } from "./channels/telegram";

/**
 * The scheduler's target. Not a poll — Convex invokes this at the instant the
 * reminder was created for, to second precision.
 *
 * In a Telegram private chat the chat id equals the user's id, so no extra
 * column is needed to know where to send.
 */
export const deliver = internalAction({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.model.reminders.forDelivery, {
      reminderId: args.reminderId,
    });

    if (!found) return;
    if (found.reminder.status !== "PENDING") return; // cancelled between schedule and fire

    await sendMessage(found.telegramId, `⏰ ${found.reminder.message}`);
    await ctx.runMutation(internal.model.reminders.markSent, {
      reminderId: args.reminderId,
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "scheduler",
      action: "reminder.deliver",
      targetType: "reminders",
      targetId: args.reminderId,
      args: { scheduledAt: found.reminder.scheduledAt },
      result: "ok",
    });
  },
});

/**
 * Hourly hygiene sweep. Scheduled functions are durable, so this should find
 * nothing; keeping it is what makes a dropped delivery a delay instead of a
 * silent loss.
 */
export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const missed = await ctx.runQuery(internal.model.reminders.findMissed, {
      // One minute of slack, so a reminder firing right now is not
      // double-delivered by a cron tick landing in the same second.
      before: Date.now() - 60_000,
    });

    for (const reminder of missed) {
      console.warn(`reminder_missed: ${reminder._id} due ${reminder.scheduledAt}`);
      await ctx.runAction(internal.reminders.deliver, { reminderId: reminder._id });
    }

    if (missed.length > 0) {
      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "reminder.reconcile",
        args: { recovered: missed.length },
        result: "ok",
      });
    }
  },
});
