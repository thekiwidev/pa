// Pure. No ctx, no fetch. Turning "tomorrow" and "this week" into the exact
// pair of instants a Calendar query needs.
//
// WHY THIS IS ITS OWN FILE
//
// "What's my day?" is a timezone question wearing a calendar question's
// clothes. The bug it invites is subtle and silent: compute the window in UTC
// and a 23:30 event shows up on the wrong day, once, and only for people who
// are not on UTC. Lagos is +01:00 permanently, which means the bug would
// never appear in a test written casually and would appear immediately in
// real use.
//
// Everything here works in calendar dates first and converts to instants
// last, which is the only ordering that survives a DST boundary.

import { toEpochMs } from "../time";

/** "2026-09-08" — the local calendar date at that instant, in that zone. */
export function localDate(atMs: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives an
  // ISO-shaped date without string surgery.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Calendar-date arithmetic, done in UTC deliberately.
 *
 * This adds DAYS to a date, not 24-hour blocks to an instant. Those are
 * different operations on a DST boundary, and only the first one is what
 * "tomorrow" means.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Midnight at the start of that local date, as an instant. */
export function startOfLocalDay(dateStr: string, timeZone: string): number {
  return toEpochMs(`${dateStr}T00:00`, timeZone);
}

export interface TimeWindow {
  startMs: number;
  endMs: number;
  /** The local dates this window covers, for rendering headings. */
  dates: string[];
}

/**
 * One whole local day, `offsetDays` from now. 0 = today, 1 = tomorrow.
 *
 * The end is computed from the NEXT DATE's midnight rather than start+24h,
 * so a day that is 23 or 25 hours long still ends where it actually ends.
 */
export function dayWindow(nowMs: number, timeZone: string, offsetDays = 0): TimeWindow {
  const date = addDays(localDate(nowMs, timeZone), offsetDays);
  const next = addDays(date, 1);
  return {
    startMs: startOfLocalDay(date, timeZone),
    endMs: startOfLocalDay(next, timeZone),
    dates: [date],
  };
}

/**
 * `days` whole local days starting today. `days: 1` is today alone.
 *
 * Used for "this week" and for the free-slot search, both of which want whole
 * days rather than a rolling N×24h from right now — "am I free Thursday" is
 * about Thursday, not about the next 72 hours.
 */
export function daysWindow(nowMs: number, timeZone: string, days: number): TimeWindow {
  const span = Math.max(1, Math.min(days, 60));
  const first = localDate(nowMs, timeZone);
  const dates: string[] = [];
  for (let i = 0; i < span; i++) dates.push(addDays(first, i));
  return {
    startMs: startOfLocalDay(first, timeZone),
    endMs: startOfLocalDay(addDays(first, span), timeZone),
    dates,
  };
}

/**
 * A window that starts NOW rather than at midnight.
 *
 * "What's left today" is a different question from "what was today", and
 * showing a 09:00 standup at 4pm as though it were upcoming is the kind of
 * small wrongness that stops a brief being trusted.
 */
export function restOfDay(nowMs: number, timeZone: string): TimeWindow {
  const window = dayWindow(nowMs, timeZone, 0);
  return { ...window, startMs: Math.max(nowMs, window.startMs) };
}

/**
 * Resolve the phrase the model was given into a window.
 *
 * Deliberately a small closed set. A model asked for a free-text date range
 * produces "next Tuesday-ish" and someone has to parse it; a model asked to
 * pick from five options picks one of five.
 */
export type WindowName = "today" | "rest_of_today" | "tomorrow" | "week" | "next_week";

export function namedWindow(name: WindowName, nowMs: number, timeZone: string): TimeWindow {
  switch (name) {
    case "rest_of_today":
      return restOfDay(nowMs, timeZone);
    case "tomorrow":
      return dayWindow(nowMs, timeZone, 1);
    case "week":
      return daysWindow(nowMs, timeZone, 7);
    case "next_week": {
      const start = addDays(localDate(nowMs, timeZone), 7);
      const dates: string[] = [];
      for (let i = 0; i < 7; i++) dates.push(addDays(start, i));
      return {
        startMs: startOfLocalDay(start, timeZone),
        endMs: startOfLocalDay(addDays(start, 7), timeZone),
        dates,
      };
    }
    case "today":
    default:
      return dayWindow(nowMs, timeZone, 0);
  }
}

/** One specific local date, "2026-10-22" — what "Thursday" resolves to. */
export function dateWindow(dateStr: string, timeZone: string): TimeWindow {
  return {
    startMs: startOfLocalDay(dateStr, timeZone),
    endMs: startOfLocalDay(addDays(dateStr, 1), timeZone),
    dates: [dateStr],
  };
}

/** A specific date wins over a named window; neither means today. */
export function resolveWindow(
  args: { window?: string; date?: string },
  nowMs: number,
  timeZone: string,
): TimeWindow {
  if (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) return dateWindow(args.date, timeZone);
  return namedWindow((args.window as WindowName | undefined) ?? "today", nowMs, timeZone);
}
