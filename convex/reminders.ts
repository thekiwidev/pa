import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendMessage } from "./channels/telegram";
import { allCalendarEvents } from "./tools/router";
import { whenToMs, isAllDay } from "./lib/calendar/events";
import { nudgeText } from "./lib/calendar/availability";

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

/**
 * "Standup in 30 min" — the assistant speaking first, without being asked
 * (docs/BEHAVIOUR.md §6). Polled every 5 minutes by crons.ts during waking
 * hours; each event is nudged exactly once (calendarNudges, check-then-insert
 * in one mutation). MEETING_NUDGE_MINUTES sets the lead time; "0" turns
 * nudges off.
 */
export const nudgeUpcoming = internalAction({
  args: {},
  handler: async (ctx) => {
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!ownerId) return;
    const leadMinutes = Number(process.env.MEETING_NUDGE_MINUTES ?? "30");
    if (!Number.isFinite(leadMinutes) || leadMinutes <= 0) return;

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId: ownerId });
    if (!user) return;

    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const nowMs = Date.now();
    const leadMs = leadMinutes * 60_000;

    let found;
    try {
      found = await allCalendarEvents(
        ctx,
        user._id,
        { startMs: nowMs, endMs: nowMs + leadMs + 60_000 },
        { limit: 10 },
      );
    } catch {
      // No calendar connected (or no calendar scope yet): nothing to nudge.
      return;
    }

    for (const { event, calendarOf } of found.events) {
      const startMs = whenToMs(event.start, timezone);
      if (startMs === null || isAllDay(event.start)) continue;
      if (startMs <= nowMs || startMs > nowMs + leadMs) continue;

      const claimed = await ctx.runMutation(internal.model.messages.claimNudge, {
        userId: user._id,
        key: `${calendarOf}:${event.id}:${startMs}`,
      });
      if (!claimed) continue;

      const text = nudgeText(
        {
          title: event.summary ?? "(no title)",
          startMs,
          link: event.hangoutLink,
          location: event.location,
        },
        nowMs,
        timezone,
      );
      const channelMessageId = await sendMessage(user.telegramId, text);
      await ctx.runMutation(internal.model.messages.record, {
        userId: user._id,
        channel: "telegram",
        direction: "out",
        channelMessageId,
        kind: "nudge",
        text,
        ref: { kind: "event", id: event.id },
      });
    }
  },
});
