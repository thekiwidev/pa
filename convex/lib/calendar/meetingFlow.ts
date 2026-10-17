// Pure. The meeting flow the assistant drives on its own (docs/BEHAVIOUR.md
// §6): a "joining?" ask a few hours ahead, then a "ready to join?" nudge a
// few minutes before, carrying the prep the user told it. No ctx, no I/O.

import { formatClock } from "../time";

/** Preferences key holding one event's prep and RSVP. */
export function meetingPrepKey(eventId: string): string {
  return `meeting.prep:${eventId}`;
}

export interface MeetingPrep {
  eventId: string;
  title: string;
  startMs: number;
  /** undefined until the user answers "joining?". false skips the ready nudge. */
  attending?: boolean;
  /** What they said they will cover: updates, questions, blockers. */
  notes: string[];
}

/** The "joining?" ask goes out this far ahead at most. */
export const ASK_AHEAD_MS = 3 * 60 * 60_000;
/** ...and never later than this before the start (the ready nudge covers it). */
export const ASK_LATEST_MS = 25 * 60_000;
/** Not before this local time, so an early meeting is asked about at breakfast, not at dawn. */
export const ASK_NOT_BEFORE = "07:00";

export type MeetingStage = "ask" | "ready" | null;

function localMinutes(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

/** Which message, if any, this event is due at `nowMs`. */
export function meetingStage(
  startMs: number,
  nowMs: number,
  timeZone: string,
  readyLeadMinutes: number,
): MeetingStage {
  const until = startMs - nowMs;
  if (until <= 0) return null;
  if (until <= readyLeadMinutes * 60_000) return "ready";
  const [h, m] = ASK_NOT_BEFORE.split(":").map(Number);
  if (localMinutes(nowMs, timeZone) < (h ?? 7) * 60 + (m ?? 0)) return null;
  if (until <= ASK_AHEAD_MS && until > ASK_LATEST_MS) return "ask";
  return null;
}

/** One purpose, one question. */
export function askText(title: string, startMs: number, timeZone: string): string {
  return `📅 You have ${title} at ${formatClock(startMs, timeZone)} today. Are you joining?`;
}

export function readyText(
  event: { title: string; startMs: number; link?: string; location?: string },
  nowMs: number,
  timeZone: string,
  prep?: MeetingPrep | null,
): string {
  const minutes = Math.max(1, Math.round((event.startMs - nowMs) / 60_000));
  const lines = [
    `📅 ${event.title} in ${minutes} min (${formatClock(event.startMs, timeZone)}). Ready to join?`,
  ];
  if (event.link) lines.push(`Join: ${event.link}`);
  else if (event.location) lines.push(`📍 ${event.location}`);
  if (prep && prep.notes.length > 0) {
    lines.push("", "Remember, you're covering:", ...prep.notes.map((n) => `- ${n}`));
  }
  return lines.join("\n");
}

/** Add a note (deduped), set attendance; returns the new record. */
export function mergePrep(
  existing: MeetingPrep | null,
  event: { eventId: string; title: string; startMs: number },
  update: { note?: string; attending?: boolean },
): MeetingPrep {
  const base: MeetingPrep = existing ?? { ...event, notes: [] };
  const notes = [...base.notes];
  const note = update.note?.trim();
  if (note && !notes.some((n) => n.toLowerCase() === note.toLowerCase())) notes.push(note);
  return {
    ...base,
    title: event.title,
    startMs: event.startMs,
    attending: update.attending ?? base.attending,
    notes,
  };
}

/** Read a stored value back as a MeetingPrep, or null. */
export function asMeetingPrep(value: unknown): MeetingPrep | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<MeetingPrep>;
  if (typeof v.eventId !== "string" || typeof v.title !== "string" || typeof v.startMs !== "number") return null;
  return {
    eventId: v.eventId,
    title: v.title,
    startMs: v.startMs,
    attending: typeof v.attending === "boolean" ? v.attending : undefined,
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string") : [],
  };
}
