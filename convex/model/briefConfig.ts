import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { toEpochMs } from "../lib/time";

/**
 * Wraps the existing (until now unused) `preferences` table under one fixed
 * key. No new table — the same "don't reinvent what already exists" instinct
 * this codebase already applies to `customInstructions`.
 */
const KEY = "morning_brief";

export interface BriefConfig {
  enabled: boolean;
  /** 24-hour local time, "HH:MM", in the user's timezone. */
  timeOfDay: string;
  notes?: string;
  /** Set whenever a delivery is actually scheduled; unset while disabled. */
  scheduledJobId?: Id<"_scheduled_functions">;
}

const DEFAULT_CONFIG: BriefConfig = { enabled: false, timeOfDay: "07:00" };

/**
 * The next ms-epoch occurrence of `timeOfDay` in `timezone`, from `fromMs`.
 * Rolls to tomorrow if that time today has already passed.
 *
 * The `en-CA` locale is a formatting trick, not a regional choice: it's the
 * one built-in Intl locale that renders as YYYY-MM-DD, which is exactly the
 * prefix `lib/time.ts`'s `toEpochMs` expects for a naive local datetime.
 */
function nextOccurrence(timeOfDay: string, timezone: string, fromMs: number): number {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(fromMs));

  const candidate = toEpochMs(`${dateStr}T${timeOfDay}`, timezone);
  return candidate > fromMs ? candidate : candidate + 24 * 60 * 60 * 1000;
}

/** Exported so `briefs.ensureScheduled` can compute a next occurrence too,
 *  without duplicating the Intl/toEpochMs logic above. */
export function nextOccurrenceOf(
  timeOfDay: string,
  timezone: string,
  fromMs = Date.now(),
): number {
  return nextOccurrence(timeOfDay, timezone, fromMs);
}

export const get = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    return (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;
  },
});

/**
 * Enable/disable/reschedule via chat. This mutation IS the whole reason the
 * schedule is user-editable with no redeploy — changing the time is just
 * calling this again with a new `timeOfDay`.
 *
 * Calling it with no arguments is a valid, deliberate no-op-ish call: it
 * returns the current config, reschedules at the same next occurrence, and
 * changes nothing else. That is what lets "what time is my brief?" be
 * answered by the same one tool instead of adding a third `brief.status`.
 */
export const configure = internalMutation({
  args: {
    userId: v.id("users"),
    timezone: v.string(),
    enabled: v.optional(v.boolean()),
    timeOfDay: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    const current = (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;

    const next: BriefConfig = {
      enabled: args.enabled ?? current.enabled,
      timeOfDay: args.timeOfDay ?? current.timeOfDay,
      notes: args.notes ?? current.notes,
    };

    // Cancel the job the OLD config owns before scheduling a new one — never
    // let two live jobs exist for the same config at once.
    if (current.scheduledJobId) {
      await ctx.scheduler.cancel(current.scheduledJobId);
    }

    let nextAt: number | undefined;
    if (next.enabled) {
      nextAt = nextOccurrence(next.timeOfDay, args.timezone, Date.now());
      next.scheduledJobId = await ctx.scheduler.runAt(nextAt, internal.briefs.deliver, {
        userId: args.userId,
      });
    } else {
      next.scheduledJobId = undefined;
    }

    if (row) {
      await ctx.db.patch("preferences", row._id, { value: next });
    } else {
      await ctx.db.insert("preferences", { userId: args.userId, key: KEY, value: next });
    }

    return { ...next, nextAt };
  },
});

/**
 * The self-perpetuating half of the chain. `briefs.deliver` calls this right
 * after sending, to schedule tomorrow's occurrence and store the new job id
 * — the same "compute, runAt, store" shape as `configure` above, just
 * without touching `enabled`/`timeOfDay`/`notes`.
 *
 * Also `ensureScheduled`'s target when it finds an enabled config with no
 * live `scheduledJobId` — the safety net for a broken chain.
 */
export const reschedule = internalMutation({
  args: { userId: v.id("users"), nextAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    const current = (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;

    // Turned off between the last delivery and this call — do not resurrect.
    if (!current.enabled) return;

    const jobId = await ctx.scheduler.runAt(args.nextAt, internal.briefs.deliver, {
      userId: args.userId,
    });
    const next: BriefConfig = { ...current, scheduledJobId: jobId };

    if (row) {
      await ctx.db.patch("preferences", row._id, { value: next });
    } else {
      await ctx.db.insert("preferences", { userId: args.userId, key: KEY, value: next });
    }
  },
});
