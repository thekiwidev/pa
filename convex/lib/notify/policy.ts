// Pure. The attention budget: WHETHER an unprompted message may reach the
// owner's phone. Every proactive sender asks decideSend() before it composes
// or sends anything; replies to the owner's own messages never come here.
//
// Three modes, set from chat ("go silent", "resume"):
//   normal  everything the owner has switched on
//   quiet   important unread mail, the owner's reminders, digests they asked for
//   silent  important unread mail and reminders only (optionally until a time)
//
// Silence from the owner lowers the volume by itself: after inactivityHours
// without an inbound message the effective mode is quiet. Dropped items are
// never queued, so there is no backlog dump when the owner comes back.

import { toEpochMs } from "../time";
import { addDays, localDate } from "../calendar/window";

export type NotifyKind =
  | "email_important"
  | "email_unread_followup"
  | "reminder"
  | "digest"
  | "news"
  | "checkin"
  | "scripture"
  | "saved_nudge"
  | "weekend_pick"
  | "meeting_nudge"
  | "ops_critical"
  | "ops_digest";

export type NotifyMode = "normal" | "quiet" | "silent";

export const NOTIFY_PREF_KEY = "notify";

export const NOTIFY_KINDS: readonly NotifyKind[] = [
  "email_important", "email_unread_followup", "reminder", "digest", "news", "checkin",
  "scripture", "saved_nudge", "weekend_pick", "meeting_nudge", "ops_critical", "ops_digest",
];

export interface NotifyPrefs {
  mode: NotifyMode;
  /** ms epoch; a silent/quiet mode lapses back to normal after this. */
  until?: number;
  /** Hours without an inbound message before normal becomes quiet. 0 = never. */
  inactivityHours: number;
  /** Local "HH:MM" window with no optional messages and deferred mail alerts. */
  quietHours: { from: string; until: string };
  /** Per-kind switch. Absent = the kind's default (see KIND_DEFAULT_ON). */
  kinds: Partial<Record<NotifyKind, boolean>>;
  /** How long an important mail may sit unread before it pages the phone. */
  emailGraceMinutes: number;
}

export const DEFAULT_PREFS: NotifyPrefs = {
  mode: "normal",
  inactivityHours: 24,
  quietHours: { from: "22:00", until: "07:00" },
  kinds: {},
  emailGraceMinutes: 15,
};

/** Chatter is opt-in; everything the owner would be annoyed to miss is on. */
const KIND_DEFAULT_ON: Record<NotifyKind, boolean> = {
  email_important: true,
  email_unread_followup: true,
  reminder: true,
  digest: true,
  news: true,
  checkin: false,
  scripture: false,
  saved_nudge: false,
  weekend_pick: false,
  meeting_nudge: true,
  ops_critical: true,
  ops_digest: true,
};

/** Cannot be switched off from chat: the owner set the reminder, and a dead
 *  token that nobody hears about is how the bot goes quiet by accident. */
const UNSWITCHABLE: ReadonlySet<NotifyKind> = new Set(["reminder", "ops_critical"]);
/** Allowed in every mode, and not held back by quiet hours. */
const ANY_MODE_NO_HOURS: ReadonlySet<NotifyKind> = new Set(["reminder", "ops_critical"]);
/** Allowed in every mode, but deferred (not dropped) during quiet hours. */
const MAIL: ReadonlySet<NotifyKind> = new Set(["email_important", "email_unread_followup"]);
/** Scheduled at a time the owner chose or asked for: normal and quiet. */
const ASKED: ReadonlySet<NotifyKind> = new Set(["digest", "news"]);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Stored value to full prefs. Anything malformed falls back field by field. */
export function notifyFrom(stored: unknown): NotifyPrefs {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const q = (typeof s.quietHours === "object" && s.quietHours !== null ? s.quietHours : {}) as Record<string, unknown>;
  const time = (value: unknown, fallback: string) =>
    typeof value === "string" && HHMM.test(value) ? value : fallback;
  const num = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  const kinds: Partial<Record<NotifyKind, boolean>> = {};
  if (typeof s.kinds === "object" && s.kinds !== null) {
    for (const kind of NOTIFY_KINDS) {
      const value = (s.kinds as Record<string, unknown>)[kind];
      if (typeof value === "boolean") kinds[kind] = value;
    }
  }
  return {
    mode: s.mode === "quiet" || s.mode === "silent" || s.mode === "normal" ? s.mode : DEFAULT_PREFS.mode,
    ...(typeof s.until === "number" && Number.isFinite(s.until) ? { until: s.until } : {}),
    inactivityHours: num(s.inactivityHours, DEFAULT_PREFS.inactivityHours, 0, 24 * 30),
    quietHours: {
      from: time(q.from, DEFAULT_PREFS.quietHours.from),
      until: time(q.until, DEFAULT_PREFS.quietHours.until),
    },
    kinds,
    emailGraceMinutes: num(s.emailGraceMinutes, DEFAULT_PREFS.emailGraceMinutes, 0, 24 * 60),
  };
}

/** The mode in force right now: the configured one, minus lapsed `until`, minus inactivity. */
export function effectiveMode(prefs: NotifyPrefs, now: number, lastInboundAt: number | undefined): NotifyMode {
  let mode = prefs.mode;
  if (mode !== "normal" && prefs.until !== undefined && prefs.until <= now) mode = "normal";
  if (
    mode === "normal" &&
    prefs.inactivityHours > 0 &&
    (lastInboundAt === undefined || now - lastInboundAt > prefs.inactivityHours * 3_600_000)
  ) {
    mode = "quiet";
  }
  return mode;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function localMinutes(atMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

export function inQuietHours(prefs: NotifyPrefs, now: number, tz: string): boolean {
  const from = minutesOf(prefs.quietHours.from);
  const until = minutesOf(prefs.quietHours.until);
  if (from === until) return false;
  const local = localMinutes(now, tz);
  return from < until ? local >= from && local < until : local >= from || local < until;
}

/** The next moment quiet hours end, for rescheduling a deferred alert. */
export function quietHoursEndMs(prefs: NotifyPrefs, now: number, tz: string): number {
  const date = localDate(now, tz);
  const today = toEpochMs(`${date}T${prefs.quietHours.until}`, tz);
  return today > now ? today : toEpochMs(`${addDays(date, 1)}T${prefs.quietHours.until}`, tz);
}

export type SendDecision = "send" | "drop" | "defer";

export interface DecideArgs {
  kind: NotifyKind;
  prefs: NotifyPrefs;
  now: number;
  lastInboundAt: number | undefined;
  tz: string;
  /** CRITICAL mail pages through quiet hours. */
  urgent?: boolean;
}

/**
 * "defer" is only ever returned for mail in quiet hours: the caller moves
 * the alert to quietHoursEndMs instead of losing it. Everything else that is
 * not allowed is "drop", never queued.
 */
export function decideSend(args: DecideArgs): SendDecision {
  const { kind, prefs, now, tz } = args;
  if (!UNSWITCHABLE.has(kind) && (prefs.kinds[kind] ?? KIND_DEFAULT_ON[kind]) === false) return "drop";
  if (ANY_MODE_NO_HOURS.has(kind)) return "send";

  const mode = effectiveMode(prefs, now, args.lastInboundAt);
  if (MAIL.has(kind)) {
    return inQuietHours(prefs, now, tz) && !args.urgent ? "defer" : "send";
  }
  if (ASKED.has(kind)) return mode === "silent" ? "drop" : "send";
  // Optional chatter: normal mode, outside quiet hours.
  if (mode !== "normal") return "drop";
  return inQuietHours(prefs, now, tz) ? "drop" : "send";
}

/* ── chat control: patching and describing the prefs ─────────────── */

export interface NotifyPatch {
  mode?: NotifyMode;
  /** Mode lapses to normal after this many hours. Ignored for mode "normal". */
  hours?: number;
  /** Absolute end (ms epoch). Wins over `hours`. */
  untilMs?: number;
  inactivityHours?: number;
  quietFrom?: string;
  quietUntil?: string;
  kinds?: Partial<Record<NotifyKind, boolean>>;
  emailGraceMinutes?: number;
}

/** A new prefs object with the patch applied. Never mutates `prefs`. */
export function applyNotifyPatch(prefs: NotifyPrefs, patch: NotifyPatch, now: number): NotifyPrefs {
  const next: NotifyPrefs = {
    ...prefs,
    quietHours: { ...prefs.quietHours },
    kinds: { ...prefs.kinds, ...patch.kinds },
  };
  if (patch.mode !== undefined) {
    next.mode = patch.mode;
    delete next.until;
    if (patch.mode !== "normal") {
      if (patch.untilMs !== undefined) next.until = patch.untilMs;
      else if (patch.hours !== undefined && patch.hours > 0) next.until = now + patch.hours * 3_600_000;
    }
  }
  if (patch.inactivityHours !== undefined) next.inactivityHours = patch.inactivityHours;
  if (patch.quietFrom !== undefined) next.quietHours.from = patch.quietFrom;
  if (patch.quietUntil !== undefined) next.quietHours.until = patch.quietUntil;
  if (patch.emailGraceMinutes !== undefined) next.emailGraceMinutes = patch.emailGraceMinutes;
  return notifyFrom(next);
}

/** "2d", "36h", "90m", "2" (hours) to hours; null when it is not a duration. */
export function parseHours(text: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m)?$/i.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "h").toLowerCase();
  const hours = unit === "d" ? n * 24 : unit === "m" ? n / 60 : n;
  return hours > 0 ? hours : null;
}

export const KIND_LABEL: Record<NotifyKind, string> = {
  email_important: "important email",
  email_unread_followup: "48h unread reminder",
  reminder: "your reminders",
  digest: "the digest",
  news: "news",
  checkin: "check-ins",
  scripture: "verses",
  saved_nudge: "saved-post nudges",
  weekend_pick: "weekend pick",
  meeting_nudge: "meeting nudges",
  ops_critical: "critical alerts",
  ops_digest: "warning digest",
};

/** The /notify text and the notify.settings answer. */
export function describeNotify(
  prefs: NotifyPrefs,
  now: number,
  lastInboundAt: number | undefined,
  formatTime: (ms: number) => string,
): string {
  const eff = effectiveMode(prefs, now, lastInboundAt);
  const lines: string[] = [];
  const until = prefs.until !== undefined && prefs.until > now ? ` until ${formatTime(prefs.until)}` : "";
  lines.push(`🔔 Mode: ${prefs.mode}${prefs.mode === "normal" ? "" : until}.`);
  if (eff !== prefs.mode) {
    lines.push(`Right now I am acting as ${eff}: you have not written for over ${prefs.inactivityHours}h. Your next message restores ${prefs.mode}.`);
  }
  const on = NOTIFY_KINDS.filter((k) => (prefs.kinds[k] ?? KIND_DEFAULT_ON[k]) !== false);
  const off = NOTIFY_KINDS.filter((k) => !on.includes(k));
  lines.push(`On: ${on.map((k) => KIND_LABEL[k]).join(", ")}.`);
  if (off.length) lines.push(`Off: ${off.map((k) => KIND_LABEL[k]).join(", ")}.`);
  lines.push(`Quiet hours ${prefs.quietHours.from}-${prefs.quietHours.until}. Auto-quiet after ${prefs.inactivityHours ? `${prefs.inactivityHours}h of silence` : "never"}. Important mail waits ${prefs.emailGraceMinutes} min for you to read it first.`);
  lines.push('Say "/silent 2d", "/quiet", "/resume", or tell me in words, e.g. "stop sending verses".');
  return lines.join("\n");
}
