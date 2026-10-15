// Pure. Convex has no Date type — every stored instant is ms-epoch, and every
// conversion between a human's wall clock and that number happens here.

/**
 * The offset of `timeZone` from UTC, in minutes, at instant `atMs`.
 * Positive east of Greenwich (Africa/Lagos = +60).
 *
 * Derived from Intl rather than hardcoded so the same code is correct for a
 * DST zone if the owner ever travels.
 */
export function offsetMinutes(timeZone: string, atMs: number): number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(new Date(atMs))) parts[p.type] = p.value;

  // Intl renders hour 24 for midnight in some engines; normalize to 0.
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );

  return Math.round((asUtc - atMs) / 60_000);
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turn a model-supplied ISO 8601 string into ms-epoch.
 *
 * - With an explicit offset or `Z`, the offset wins and `timeZone` is ignored.
 * - Without one ("2026-08-21T10:00"), it is read as wall-clock time in
 *   `timeZone`. This is the common case: the model writes what the user said.
 *
 * Throws on anything it cannot parse. A reminder scheduled at NaN is a
 * reminder that never fires, and that must not be a silent outcome.
 */
export function toEpochMs(iso: string, timeZone: string): number {
  const trimmed = iso.trim();
  const naive = NAIVE.exec(trimmed);

  if (!naive) {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) throw new Error(`Unparseable datetime: ${iso}`);
    return parsed;
  }

  const [, y, mo, d, h, mi, s] = naive;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
  );

  // Two passes: the offset depends on the instant, and the instant depends on
  // the offset. One correction is enough outside the DST transition hour.
  const firstGuess = asUtc - offsetMinutes(timeZone, asUtc) * 60_000;
  return asUtc - offsetMinutes(timeZone, firstGuess) * 60_000;
}

/** "Thu 21 Aug 2026, 10:00" in the given zone — for prompts and Telegram. */
export function formatInstant(atMs: number, timeZone: string): string {
  const p = dateParts(atMs, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${formatClock(atMs, timeZone)}`;
}

/**
 * Weekday, day, month and year as separate strings. Assembled by hand
 * because ICU's en-GB patterns differ between versions ("Thu 15 Oct" vs
 * "Thu, 15 Oct"), and user-facing text must not change with the runtime.
 */
function dateParts(
  atMs: number,
  timeZone: string,
): { weekday: string; day: string; month: string; year: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === type)?.value ?? "";
  return { weekday: get("weekday"), day: get("day"), month: get("month"), year: get("year") };
}

/**
 * "09:42". Date and clock are formatted separately and joined by hand: the
 * combined en-GB pattern is ICU-version dependent (newer ICU, e.g. Bun 1.4 on
 * macOS, writes "Thu 15 Oct at 09:42"; older writes "Thu 15 Oct, 09:42").
 */
export function formatClock(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(atMs));
}

/** "Fri 5 Sep" — a date with no clock, for search windows and list rows. */
export function formatDay(atMs: number, timeZone: string): string {
  const p = dateParts(atMs, timeZone);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Fri 5 Sep, 14:22" — a list row needs the time but not the year. */
export function formatDayTime(atMs: number, timeZone: string): string {
  return `${formatDay(atMs, timeZone)}, ${formatClock(atMs, timeZone)}`;
}

/**
 * "today 09:42", "yesterday 21:10", or "Thu 24 Sep, 09:42" — how a person
 * says when something arrived. Day boundaries are the user's own midnight.
 */
export function formatWhen(atMs: number, nowMs: number, timeZone: string): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(ms),
    );
  const clock = formatClock(atMs, timeZone);

  if (day(atMs) === day(nowMs)) return `today ${clock}`;
  if (day(atMs) === day(nowMs - 86_400_000)) return `yesterday ${clock}`;
  return formatDayTime(atMs, timeZone);
}
