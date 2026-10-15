// Pure. "Am I free then?" across every calendar, with the near misses a good
// assistant mentions unprompted ("yes — but you have a call at 4:15").

export interface CalendarItem {
  title: string;
  startMs: number;
  endMs: number;
  /** Which connected account's calendar this came from. */
  calendarOf: string;
  allDay?: boolean;
}

export interface AvailabilityAnswer {
  free: boolean;
  /** Events that overlap the asked-about time. */
  conflicts: CalendarItem[];
  /** Events that do not overlap but start or end within `marginMs` of it. */
  nearby: CalendarItem[];
}

export const NEARBY_MARGIN_MS = 60 * 60_000;

/**
 * All-day events are reported as nearby context, never as a conflict: an
 * all-day "Mum's birthday" does not make 3pm busy, and treating it so made
 * every day look booked.
 */
export function checkAvailability(options: {
  startMs: number;
  endMs: number;
  events: CalendarItem[];
  marginMs?: number;
}): AvailabilityAnswer {
  const margin = options.marginMs ?? NEARBY_MARGIN_MS;
  const conflicts: CalendarItem[] = [];
  const nearby: CalendarItem[] = [];

  for (const event of options.events) {
    const overlaps = event.startMs < options.endMs && event.endMs > options.startMs;
    if (overlaps && !event.allDay) {
      conflicts.push(event);
      continue;
    }
    const close =
      event.startMs < options.endMs + margin && event.endMs > options.startMs - margin;
    if (close || (overlaps && event.allDay)) nearby.push(event);
  }

  const byStart = (a: CalendarItem, b: CalendarItem) => a.startMs - b.startMs;
  return { free: conflicts.length === 0, conflicts: conflicts.sort(byStart), nearby: nearby.sort(byStart) };
}

/**
 * Events starting within (now, now + leadMs] that have not started yet — the
 * ones a "starts in 30 minutes" nudge is for. All-day events never nudge.
 */
export function upcomingForNudge(
  events: CalendarItem[],
  nowMs: number,
  leadMs: number,
): CalendarItem[] {
  return events
    .filter((e) => !e.allDay && e.startMs > nowMs && e.startMs <= nowMs + leadMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Same event seen on two calendars (you and a colleague both invited) → one. */
export function dedupeEvents(events: CalendarItem[]): CalendarItem[] {
  const seen = new Set<string>();
  const out: CalendarItem[] = [];
  for (const e of events) {
    const key = `${e.title.trim().toLowerCase()}|${e.startMs}|${e.endMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** "📅 Standup in 30 min (10:00)" plus where to join, when known. */
export function nudgeText(
  event: { title: string; startMs: number; link?: string; location?: string },
  nowMs: number,
  timeZone: string,
): string {
  const minutes = Math.max(1, Math.round((event.startMs - nowMs) / 60_000));
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(event.startMs));
  const where = event.link
    ? `\nJoin: ${event.link}`
    : event.location
      ? `\n📍 ${event.location}`
      : "";
  return `📅 ${event.title} in ${minutes} min (${clock}).${where}`;
}
