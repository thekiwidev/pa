/**
 * Which of an account's calendars to read. Before 2026-10-16 only `primary`
 * was read, so anything kept on a second calendar ("Work", a shared team
 * calendar, a subscribed one) was invisible and "what's on my calendar?"
 * answered "nothing".
 *
 * The rule mirrors what the user sees in Google Calendar: every calendar
 * ticked in the sidebar and not hidden, plus primary always. The
 * contacts-birthdays and week-number calendars are noise, not plans.
 */

export interface CalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
}

export const MAX_CALENDARS_PER_ACCOUNT = 10;

const NOISE = [/#contacts@group\.v\.calendar\.google\.com$/, /#weeknum@group\.v\.calendar\.google\.com$/];

export function calendarsToRead(items: CalendarListEntry[]): string[] {
  const keep = items.filter(
    (c) => c.primary === true || (c.selected === true && c.hidden !== true && !NOISE.some((n) => n.test(c.id))),
  );
  if (keep.length === 0) return ["primary"];
  keep.sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
  return keep.slice(0, MAX_CALENDARS_PER_ACCOUNT).map((c) => c.id);
}
