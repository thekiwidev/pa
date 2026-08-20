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
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(atMs));
}
