// Pure. WHEN a verse goes out unprompted. The cron (convex/crons.ts) ticks
// every 30 minutes; this decides whether the tick sends, and the caller's
// claim on `key` makes each send happen once.
//
//   morning   once a day at settings.morning: thanksgiving, mostly Psalms
//   interval  every couple of hours through the day, about what is going on
//   moment    right after a message that sounds like it needs one
//             (lib/scripture/moment.ts) — rate-limited here too

import { toEpochMs } from "../time";
import { localDate } from "../calendar/window";
import { daySeed } from "../personas";
import type { NeedId } from "./needs";

/** The preferences key everything below is stored under. */
export const SCRIPTURE_PREF_KEY = "scripture";

export interface ScriptureSettings {
  enabled: boolean;
  /** Translation code ("KJV"); unset = the first one imported. */
  translation?: string;
  /** Local "HH:MM" for the morning verse. */
  morning: string;
  /** Local window for interval verses. */
  from: string;
  until: string;
  /** Minutes between interval verses, before the day's jitter. */
  gapMinutes: number;
}

export const DEFAULT_SETTINGS: ScriptureSettings = {
  enabled: true,
  morning: "06:30",
  from: "09:00",
  until: "21:30",
  gapMinutes: 150,
};

/** Every verse a day, of every trigger. Past this, nothing unprompted. */
export const MAX_PER_DAY = 8;
/** Moment verses a day, inside MAX_PER_DAY. */
export const MAX_MOMENTS_PER_DAY = 4;
/** Shortest gap between two moment verses. */
export const MOMENT_COOLDOWN_MS = 45 * 60_000;
/** The morning verse may go out this late after its time (sleep-in, outage). */
export const MORNING_WINDOW_MS = 3 * 60 * 60_000;
/** An interval verse waits while the user wrote this recently. */
export const QUIET_AFTER_USER_MS = 10 * 60_000;
/** …and never lands within this long of a personality check-in. */
export const SPACING_FROM_CHECKIN_MS = 20 * 60_000;
/** Day-seeded extra minutes on the gap, so it never feels like a timer. */
export const GAP_JITTER_MINUTES = 40;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Stored value → full settings. Anything malformed falls back field by field. */
export function settingsFrom(stored: unknown): ScriptureSettings {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const time = (value: unknown, fallback: string) =>
    typeof value === "string" && HHMM.test(value) ? value : fallback;
  const gap = Number(s.gapMinutes);
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SETTINGS.enabled,
    ...(typeof s.translation === "string" && s.translation.trim()
      ? { translation: s.translation.trim().toUpperCase() }
      : {}),
    morning: time(s.morning, DEFAULT_SETTINGS.morning),
    from: time(s.from, DEFAULT_SETTINGS.from),
    until: time(s.until, DEFAULT_SETTINGS.until),
    gapMinutes: Number.isFinite(gap) && gap >= 60 && gap <= 720 ? Math.round(gap) : DEFAULT_SETTINGS.gapMinutes,
  };
}

export type ScriptureTrigger = "morning" | "interval" | "moment" | "asked";

export interface SentToday {
  trigger: ScriptureTrigger;
  sentAt: number;
}

export type ScriptureDecision =
  | { send: true; trigger: "morning" | "interval"; key: string; need?: NeedId }
  | {
      send: false;
      reason: "off" | "daily_cap" | "outside_hours" | "user_active" | "near_checkin" | "too_soon";
    };

export interface DecideArgs {
  settings: ScriptureSettings;
  nowMs: number;
  timezone: string;
  /** Every verse sent today (local), any trigger. */
  today: SentToday[];
  lastInboundMs?: number;
  lastCheckinMs?: number;
}

/** The interval gap today, jitter included. */
export function gapToday(settings: ScriptureSettings, date: string): number {
  return Math.round(settings.gapMinutes + daySeed(`scripture:${date}`) * GAP_JITTER_MINUTES);
}

export function decideScripture(args: DecideArgs): ScriptureDecision {
  const { settings, nowMs, timezone, today } = args;
  if (!settings.enabled) return { send: false, reason: "off" };
  if (today.length >= MAX_PER_DAY) return { send: false, reason: "daily_cap" };
  const date = localDate(nowMs, timezone);

  // 1. Morning — always first, and never held back for an active chat:
  //    it is how the day starts, and it is one message.
  const morningMs = toEpochMs(`${date}T${settings.morning}`, timezone);
  const hadMorning = today.some((s) => s.trigger === "morning");
  if (!hadMorning && nowMs >= morningMs && nowMs < morningMs + MORNING_WINDOW_MS) {
    return { send: true, trigger: "morning", key: `scripture:morning:${date}`, need: "thanksgiving" };
  }

  // 2. Interval — inside the day's window, a couple of hours after the last verse.
  const fromMs = toEpochMs(`${date}T${settings.from}`, timezone);
  const untilMs = toEpochMs(`${date}T${settings.until}`, timezone);
  if (nowMs < fromMs || nowMs >= untilMs) return { send: false, reason: "outside_hours" };

  const lastSent = today.reduce((max, s) => Math.max(max, s.sentAt), 0);
  // The first interval verse comes an hour into the window (10:00 by
  // default), not the moment it opens.
  const since = Math.max(lastSent, fromMs - gapToday(settings, date) * 60_000 + 60 * 60_000);
  if (nowMs - since < gapToday(settings, date) * 60_000) return { send: false, reason: "too_soon" };
  if (args.lastInboundMs !== undefined && nowMs - args.lastInboundMs < QUIET_AFTER_USER_MS) {
    return { send: false, reason: "user_active" };
  }
  if (args.lastCheckinMs !== undefined && nowMs - args.lastCheckinMs < SPACING_FROM_CHECKIN_MS) {
    return { send: false, reason: "near_checkin" };
  }
  const bucket = Math.floor((nowMs - toEpochMs(`${date}T00:00`, timezone)) / (30 * 60_000));
  return { send: true, trigger: "interval", key: `scripture:interval:${date}:${bucket}` };
}

export type MomentDecision =
  | { send: true; key: string }
  | { send: false; reason: "off" | "daily_cap" | "moment_cap" | "cooldown" };

/** Whether a detected moment gets a verse now. */
export function decideMoment(args: {
  settings: ScriptureSettings;
  nowMs: number;
  timezone: string;
  today: SentToday[];
}): MomentDecision {
  if (!args.settings.enabled) return { send: false, reason: "off" };
  if (args.today.length >= MAX_PER_DAY) return { send: false, reason: "daily_cap" };
  const moments = args.today.filter((s) => s.trigger === "moment");
  if (moments.length >= MAX_MOMENTS_PER_DAY) return { send: false, reason: "moment_cap" };
  const last = args.today.reduce((max, s) => Math.max(max, s.sentAt), 0);
  if (args.nowMs - last < MOMENT_COOLDOWN_MS) return { send: false, reason: "cooldown" };
  const date = localDate(args.nowMs, args.timezone);
  return { send: true, key: `scripture:moment:${date}:${Math.floor(args.nowMs / MOMENT_COOLDOWN_MS)}` };
}

/** Local midnight today, for "what was sent today". */
export function startOfToday(nowMs: number, timezone: string): number {
  return toEpochMs(`${localDate(nowMs, timezone)}T00:00`, timezone);
}

/** /scripture and scripture.settings with no arguments. */
export function describeSettings(
  settings: ScriptureSettings,
  translations: { code: string; name: string; verseCount: number }[],
  sentToday: number,
): string {
  if (translations.length === 0) {
    return [
      "📖 No Bible imported yet, so there is nothing to read from.",
      "Put a Bible file in assets/bibles/ and run `bun scripts/import-bible.ts assets/bibles/<file>` — docs/SCRIPTURE.md has the formats and links.",
    ].join("\n");
  }
  const active =
    translations.find((t) => t.code === settings.translation) ?? translations[0]!;
  return [
    `📖 Verses are ${settings.enabled ? "on" : "off"}. Reading from ${active.code} (${active.name}).`,
    `Morning verse at ${settings.morning}; through the day every ${Math.round(settings.gapMinutes / 60 * 10) / 10}h or so between ${settings.from} and ${settings.until}, plus when something you say sounds like it needs one.`,
    `Sent today: ${sentToday}.`,
    `Imported: ${translations.map((t) => `${t.code} (${t.verseCount.toLocaleString("en-US")} verses)`).join(", ")}.`,
    "",
    '"/scripture off", "/scripture KJV", "/scripture morning 06:15", or "/verse" for one now.',
  ].join("\n");
}
