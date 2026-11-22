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

export type BriefSection = "email" | "calendar" | "news" | "verse";

/** What the digest held before sections existed: the brief and the morning verse. */
export const DEFAULT_SECTIONS: BriefSection[] = ["email", "calendar", "verse"];

export interface BriefSlot {
  timeOfDay: string;
  sections: BriefSection[];
}

export interface BriefConfig {
  enabled: boolean;
  /** 24-hour local time, "HH:MM", in the user's timezone. */
  timeOfDay: string;
  /** What the main digest contains. Absent = DEFAULT_SECTIONS. */
  sections?: BriefSection[];
  /** Further digests at other times of day, each with its own sections. */
  extraTimes?: BriefSlot[];
  notes?: string;
  /** Set whenever a delivery is actually scheduled; unset while disabled. */
  scheduledJobId?: Id<"_scheduled_functions">;
}

const DEFAULT_CONFIG: BriefConfig = { enabled: false, timeOfDay: "07:00" };

const sectionV = v.union(v.literal("email"), v.literal("calendar"), v.literal("news"), v.literal("verse"));

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

/** Every digest the owner has configured: the main one, then the extras. */
export function slotsOf(config: BriefConfig): BriefSlot[] {
  return [
    { timeOfDay: config.timeOfDay, sections: config.sections ?? DEFAULT_SECTIONS },
    ...(config.extraTimes ?? []),
  ];
}

/** The earliest upcoming digest after `fromMs`, and which slot it is. */
export function nextSlot(config: BriefConfig, timezone: string, fromMs = Date.now()): { at: number; slot: BriefSlot } {
  return slotsOf(config)
    .map((slot) => ({ at: nextOccurrence(slot.timeOfDay, timezone, fromMs), slot }))
    .reduce((a, b) => (b.at < a.at ? b : a));
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
    sections: v.optional(v.array(sectionV)),
    extraTimes: v.optional(v.array(v.object({ timeOfDay: v.string(), sections: v.array(sectionV) }))),
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
      sections: args.sections ?? current.sections,
      extraTimes: args.extraTimes ?? current.extraTimes,
    };

    // Cancel the job the OLD config owns before scheduling a new one — never
    // let two live jobs exist for the same config at once.
    if (current.scheduledJobId) {
      await ctx.scheduler.cancel(current.scheduledJobId);
    }

    let nextAt: number | undefined;
    if (next.enabled) {
      const upcoming = nextSlot(next, args.timezone, Date.now());
      nextAt = upcoming.at;
      next.scheduledJobId = await ctx.scheduler.runAt(nextAt, internal.briefs.deliver, {
        userId: args.userId,
        slotTime: upcoming.slot.timeOfDay,
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
  args: { userId: v.id("users"), timezone: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    const current = (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;

    // Turned off between the last delivery and this call — do not resurrect.
    if (!current.enabled) return;

    // 60 s past now, so the digest that just fired is not picked again.
    const upcoming = nextSlot(current, args.timezone, Date.now() + 60_000);
    const jobId = await ctx.scheduler.runAt(upcoming.at, internal.briefs.deliver, {
      userId: args.userId,
      slotTime: upcoming.slot.timeOfDay,
    });
    const next: BriefConfig = { ...current, scheduledJobId: jobId };

    if (row) {
      await ctx.db.patch("preferences", row._id, { value: next });
    } else {
      await ctx.db.insert("preferences", { userId: args.userId, key: KEY, value: next });
    }
  },
});
