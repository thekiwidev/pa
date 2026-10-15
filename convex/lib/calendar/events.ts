// Pure. No ctx, no fetch. What an event MEANS, separated from how it is
// fetched.
//
// The load-bearing function here is `otherAttendees`. Phase 10's whole safety
// rule turns on it: an event with other people needs your approval, an event
// with nobody else does not. Getting that predicate wrong in either direction
// is the difference between a nagging assistant and one that emails your
// clients without asking.

import { startOfLocalDay, addDays } from "./window";

export interface EventWhen {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface EventLike {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start: EventWhen;
  end: EventWhen;
  attendees?: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
  organizer?: { email?: string; self?: boolean };
}

/** A bare `date` with no `dateTime` is Google's way of saying "all day". */
export function isAllDay(when: EventWhen): boolean {
  return !when.dateTime && Boolean(when.date);
}

/**
 * The instant an event boundary falls on.
 *
 * An all-day event has only a date, so it is anchored to local midnight —
 * `startOfLocalDay`, not `Date.parse`, because `Date.parse("2026-09-08")`
 * is UTC midnight and lands on the previous evening for anyone east of
 * Greenwich. That is the same off-by-one-day this module exists to prevent.
 */
export function whenToMs(when: EventWhen, timeZone: string): number | null {
  if (when.dateTime) {
    const parsed = Date.parse(when.dateTime);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (when.date) return startOfLocalDay(when.date, timeZone);
  return null;
}

/**
 * Google's END for an all-day event is EXCLUSIVE — a one-day event on the
 * 8th ends "2026-09-09". Rendering that literally tells the user a one-day
 * thing spans two days.
 */
export function displayEndMs(event: EventLike, timeZone: string): number | null {
  const end = whenToMs(event.end, timeZone);
  if (end === null) return null;
  if (!isAllDay(event.end)) return end;
  return startOfLocalDay(addDays(event.end.date!, -1), timeZone);
}

/**
 * Everyone on the event who is not you.
 *
 * THIS IS THE APPROVAL PREDICATE. Three things make it less obvious than it
 * looks, and all three have to be handled or the rule leaks:
 *
 *  1. Google marks your own attendee row `self: true` — but only sometimes,
 *     depending on which calendar the event was read from. So the account's
 *     own address is also compared directly.
 *  2. A solo event you created often still has ONE attendee: you. That must
 *     not count, or blocking your own focus time would demand a tap.
 *  3. Resource rooms come through as attendees with addresses like
 *     `c_188...@resource.calendar.google.com`. A meeting room is not a
 *     person and cannot be embarrassed by a wrong invitation.
 */
export function otherAttendees(event: EventLike, selfEmails: string[]): string[] {
  const mine = new Set(selfEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  return (event.attendees ?? [])
    .filter((a) => {
      const email = (a.email ?? "").trim().toLowerCase();
      if (!email) return false;
      if (a.self === true) return false;
      if (mine.has(email)) return false;
      if (email.endsWith("@resource.calendar.google.com")) return false;
      return true;
    })
    .map((a) => a.email);
}

/** Does creating or changing this event affect somebody other than you? */
export function affectsOthers(attendeeEmails: string[], selfEmails: string[]): boolean {
  const mine = new Set(selfEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  return attendeeEmails.some((raw) => {
    const email = raw.trim().toLowerCase();
    return Boolean(email) && !mine.has(email) && !email.endsWith("@resource.calendar.google.com");
  });
}

// ── Free-slot search ──────────────────────────────────────────────────────

export interface Interval {
  startMs: number;
  endMs: number;
}

/** Overlapping and touching intervals collapsed into one. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** What counts as bookable time, in local hours. */
export interface WorkingHours {
  startHour: number;
  endHour: number;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { startHour: 9, endHour: 18 };

/**
 * Gaps of at least `durationMs` that are inside working hours on the given
 * local dates, and not already busy.
 *
 * Bounded to whole local days rather than a rolling window because "when am
 * I free this week" means "on which of these days", and an answer of
 * 02:30 on Thursday is not an answer.
 */
export function findFreeSlots(options: {
  dates: string[];
  timeZone: string;
  busy: Interval[];
  durationMs: number;
  nowMs: number;
  workingHours?: WorkingHours;
  limit?: number;
}): Interval[] {
  const hours = options.workingHours ?? DEFAULT_WORKING_HOURS;
  const busy = mergeIntervals(options.busy);
  const found: Interval[] = [];
  const limit = options.limit ?? 10;

  for (const date of options.dates) {
    const midnight = startOfLocalDay(date, options.timeZone);
    const dayStart = midnight + hours.startHour * 3_600_000;
    const dayEnd = midnight + hours.endHour * 3_600_000;

    // Never propose a slot in the past — the most obviously wrong answer a
    // scheduling assistant can give.
    let cursor = Math.max(dayStart, options.nowMs);

    for (const block of busy) {
      if (block.endMs <= cursor) continue;
      if (block.startMs >= dayEnd) break;

      const gapEnd = Math.min(block.startMs, dayEnd);
      if (gapEnd - cursor >= options.durationMs) {
        found.push({ startMs: cursor, endMs: gapEnd });
        if (found.length >= limit) return found;
      }
      cursor = Math.max(cursor, block.endMs);
    }

    if (dayEnd - cursor >= options.durationMs) {
      found.push({ startMs: cursor, endMs: dayEnd });
      if (found.length >= limit) return found;
    }
  }

  return found;
}
