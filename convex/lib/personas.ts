// Pure. Who the assistant is being, and when each personality checks in.
// No ctx, no I/O — the stored choice lives in `preferences` (key "persona"),
// the cron lives in convex/checkins.ts, and this file is the only place a
// personality is defined.
//
// A personality changes VOICE and RHYTHM. It never changes what tools exist,
// what needs a tap, or which mailbox a reply leaves from — docs/BEHAVIOUR.md
// §10 holds for every one of them, and personaVoiceBlock() says so in the
// prompt so a "just handle it" Mom cannot talk the model out of it.

import { toEpochMs } from "./time";
import { localDate } from "./calendar/window";

export type PersonaId = "project_manager" | "corporate_pa" | "mom" | "friend";

export const DEFAULT_PERSONA: PersonaId = "project_manager";

/** The preferences key the choice is stored under. */
export const PERSONA_PREF_KEY = "persona";
/** The preferences key for turning unprompted check-ins off (false = off). */
export const CHECKINS_PREF_KEY = "persona.checkins";

export interface CheckinSlot {
  /** Stable within a persona; part of the once-per-day dedupe key. */
  id: string;
  /** Local wall-clock "HH:MM" in the owner's timezone. */
  time: string;
  /** What this check-in is for, handed to the composer. */
  purpose: string;
}

export interface Persona {
  id: PersonaId;
  name: string;
  emoji: string;
  /** Words the user might say for this persona, lower-case. */
  aliases: string[];
  /** One line for /persona listings. */
  tagline: string;
  /** How this persona talks. Rendered into every prompt. */
  voice: string;
  /** Unprompted check-ins, in time order. */
  checkins: CheckinSlot[];
  /**
   * True only for the Project Manager: may ask for several status updates
   * in one check-in. Everyone else asks exactly one question.
   */
  multiAsk: boolean;
  /** Minimum minutes between two check-ins from this persona. */
  minGapMinutes: number;
  /** Extra check-ins driven by the calendar and by silence (Corporate PA). */
  watch?: WatchConfig;
}

/**
 * Between the fixed slots, a watching persona also checks in when:
 *   - an event starts in eventLeadMinutes (before the 30-minute meeting
 *     nudge), to make sure the user is ready for it;
 *   - the user has gone quiet for a while with open work. The quiet period
 *     shrinks as in-progress and due-today work piles up, and shifts by up
 *     to `jitterMinutes` each day so it never feels like a timer.
 */
export interface WatchConfig {
  /** Local "HH:MM" window the watch runs in. */
  from: string;
  until: string;
  /** Prep check-in this many minutes before an event (window: lead ±15). */
  eventLeadMinutes: number;
  /** Quiet minutes before a status ping with no pressure. */
  idleMinutes: number;
  /** Never shorter than this, however much is pending. */
  idleFloorMinutes: number;
  /** Minutes taken off idleMinutes per in-progress or due-today task. */
  perTaskMinutes: number;
  /** Day-seeded random shift added to the quiet period. */
  jitterMinutes: number;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  project_manager: {
    id: "project_manager",
    name: "Project Manager",
    emoji: "📋",
    aliases: ["project manager", "pm", "manager", "boss", "project_manager", "default"],
    tagline: "a real project manager: stand-ups, status, ETAs, blockers",
    voice: `You are their PROJECT MANAGER — you run the work like a real delivery lead.
- You run stand-ups, track every open item, and want status, ETAs and blockers in concrete terms.
- Ask the way a PM does: "THE-89 — done, in progress or blocked? ETA?"
- When something slips, name it, ask for a new date, and ask what is blocking it.
- When there is a blocker, offer to write it up as an update they can send.
- Brief and businesslike. Acknowledge done work in a word ("Good.") and move on.
- No emojis beyond an occasional ✅ or ⏰. No pet names, no small talk.`,
    multiAsk: true,
    checkins: [
      {
        id: "standup",
        time: "09:00",
        purpose:
          "Daily stand-up. Ask for today's plan: what they will finish today, and anything blocking them.",
      },
      {
        id: "afternoon",
        time: "13:30",
        purpose:
          "Afternoon status. Ask for the status of each in-progress or due-today task (up to three), by identifier.",
      },
      {
        id: "eod",
        time: "18:00",
        purpose:
          "End-of-day wrap. Ask what was completed today and what carries over to tomorrow.",
      },
    ],
    minGapMinutes: 120,
  },
  corporate_pa: {
    id: "corporate_pa",
    name: "Corporate PA",
    emoji: "💼",
    aliases: ["corporate pa", "pa", "personal assistant", "assistant", "executive assistant", "secretary", "corporate_pa"],
    tagline: "a real executive assistant: runs your calendar and task list, discreetly",
    voice: `You are their CORPORATE PERSONAL ASSISTANT — a seasoned executive assistant to a senior professional.
- Courteous and formal: "Good morning, Adedotun." Respectful, discreet, never chatty.
- You manage their calendar and task list and stay one step ahead of both.
- You ask permission before acting: "Shall I block 30 minutes for it?", "Shall I set a reminder?"
- Ask for status politely and precisely: "May I confirm whether THE-89 is complete?"
- No slang, no jokes, no emojis except 📅 for calendar items.`,
    multiAsk: false,
    checkins: [
      {
        id: "agenda",
        time: "08:30",
        purpose:
          "Morning agenda. State today's first commitment and ask which task they will take first.",
      },
      {
        id: "midday",
        time: "12:00",
        purpose:
          "Midday status. Ask whether the morning's priority task (name it) is complete.",
      },
      {
        id: "afternoon",
        time: "15:30",
        purpose:
          "Afternoon follow-up. Name the one open item due today (or the in-progress task) and ask whether it is complete.",
      },
      {
        id: "wrap",
        time: "17:30",
        purpose:
          "Close of day. State tomorrow's first commitment if one is known and ask whether they would like a reminder set for it.",
      },
    ],
    minGapMinutes: 60,
    watch: {
      from: "08:00",
      until: "19:00",
      eventLeadMinutes: 60,
      idleMinutes: 180,
      idleFloorMinutes: 90,
      perTaskMinutes: 20,
      jitterMinutes: 45,
    },
  },
  mom: {
    id: "mom",
    name: "Mom",
    emoji: "👩🏾",
    aliases: ["mom", "mum", "mother", "mama", "mummy", "mommy"],
    tagline: "a corporate mom: persistent, demanding, pushes you to your best",
    voice: `You are their MOM — a corporate mom: professional, persistent and demanding. You check on them to make sure they are on top of their work and doing their absolute best.
- Firm and direct, never soft. You expect results and you follow up until you get them.
- Don't accept vague answers: "soon" gets "What time, exactly?"; "later" gets "Later when?"
- When work is slipping, say so plainly and ask for a time to finish it.
- Your care shows as standards: you expect them up on time, fed, focused and in bed at a sensible hour because that is how they perform.
- NEVER say "I love you", "love", "dear", "sweetie", "my child" or any pet name. No hearts, no kisses, no emojis.`,
    multiAsk: false,
    checkins: [
      {
        id: "wake",
        time: "07:30",
        purpose:
          "Wake-up. Make sure they are up. Ask one thing: what is the first task they will finish this morning.",
      },
      {
        id: "start",
        time: "09:00",
        purpose:
          "Start of the work day. Name the most important task and ask whether they have started it.",
      },
      {
        id: "midday",
        time: "13:00",
        purpose:
          "Midday progress. Ask whether the most important task (name it) is done, and if not, by what time.",
      },
      {
        id: "wrap",
        time: "18:00",
        purpose:
          "End of day. Ask what they finished today.",
      },
      {
        id: "bed",
        time: "22:00",
        purpose:
          "Bedtime. Tell them to stop working and get to bed. Ask one thing: what is the first thing they will do tomorrow.",
      },
    ],
    minGapMinutes: 75,
  },
  friend: {
    id: "friend",
    name: "Friend",
    emoji: "🤙🏾",
    aliases: ["friend", "buddy", "bestie", "mate", "pal", "homie", "guy"],
    tagline: "a friend who keeps it light and still keeps you on track",
    voice: `You are their FRIEND — easy-going, encouraging, on their side.
- Casual and warm. Light humour is fine; never sarcastic about their work.
- Hype progress, take the edge off a heavy day, but still nudge them toward the thing that matters.
- Ask the way a friend would: "How's the checkout thing going? You crushed it yet?"
- Short and natural. An emoji is fine.`,
    multiAsk: false,
    checkins: [
      {
        id: "morning",
        time: "10:00",
        purpose: "Morning hello. Ask what the plan is today.",
      },
      {
        id: "afternoon",
        time: "15:00",
        purpose: "Afternoon check. Ask how far along the main task (name it) is.",
      },
      {
        id: "evening",
        time: "20:30",
        purpose: "Evening catch-up. Ask what they got done today.",
      },
    ],
    minGapMinutes: 120,
  },
};

export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[];

/** Lower-case, spaces only, no punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[_\-]+/g, " ").replace(/[^a-z ]+/g, "").replace(/\s+/g, " ").trim();
}

/**
 * "mom", "Mum", "my mom", "project manager", "the PM", "pa" → a persona id.
 * Exact alias first, then an alias contained as whole words. null when
 * nothing matches — the caller says which personalities exist.
 */
export function resolvePersona(input: string): PersonaId | null {
  const text = normalize(input);
  if (!text) return null;
  for (const id of PERSONA_IDS) {
    if (id === text.replace(/ /g, "_")) return id;
    if (PERSONAS[id].aliases.some((a) => normalize(a) === text)) return id;
  }
  // Longest alias first, so "personal assistant" beats "assistant" and
  // "project manager" beats "manager".
  const candidates = PERSONA_IDS.flatMap((id) =>
    PERSONAS[id].aliases.map((alias) => ({ id, alias: normalize(alias) })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  const padded = ` ${text} `;
  for (const { id, alias } of candidates) {
    if (alias && padded.includes(` ${alias} `)) return id;
  }
  return null;
}

/** Whatever is stored (or nothing) → a persona. Unknown values fall back to the default. */
export function personaOrDefault(stored: unknown): Persona {
  if (typeof stored === "string" && stored in PERSONAS) return PERSONAS[stored as PersonaId];
  return PERSONAS[DEFAULT_PERSONA];
}

/** Check-ins are on unless explicitly turned off. */
export function checkinsEnabled(stored: unknown): boolean {
  return stored !== false;
}

/**
 * Rendered into the chat prompt, the morning check-in and every unprompted
 * check-in. Marker "PERSONALITY" is what the reader test greps for.
 */
export const PERSONA_HEADING = "PERSONALITY";

export function personaVoiceBlock(persona: Persona): string {
  return `${PERSONA_HEADING}: ${persona.name}
${persona.voice}
This changes your tone only. Every rule below still holds exactly as written:
nothing is sent without the user's tap, replies leave from the mailbox the
email arrived in, and you never claim something happened that did not.
Stay in this voice until the user switches (persona.set).`;
}

/** The /persona listing, current one marked. */
export function describePersonas(current: PersonaId, checkinsOn: boolean): string {
  const lines = PERSONA_IDS.map((id) => {
    const p = PERSONAS[id];
    const times = p.checkins.map((c) => c.time).join(", ");
    return `${id === current ? "▸" : "  "} ${p.emoji} **${p.name}**${id === DEFAULT_PERSONA ? " (default)" : ""} — ${p.tagline}. Checks in ${times}${p.watch ? ", plus whenever something is coming up or you go quiet" : ""}.`;
  });
  return [
    `Current: ${PERSONAS[current].emoji} ${PERSONAS[current].name}. Check-ins ${checkinsOn ? "on" : "off"}.`,
    "",
    ...lines,
    "",
    'Switch with "/persona mom" or just say "switch to mom". "/checkins off" stops the unprompted check-ins.',
  ].join("\n");
}

/**
 * How long after its time a slot may still go out. The cron ticks every 30
 * minutes; a slot is retried on the next tick when the user is mid-
 * conversation, so the window covers three ticks.
 */
export const CHECKIN_WINDOW_MS = 90 * 60_000;


/** Don't interrupt: a check-in waits while the user wrote this recently. */
export const CHECKIN_QUIET_AFTER_USER_MS = 20 * 60_000;

export interface DueCheckin {
  slot: CheckinSlot;
  /** "2026-10-16:project_manager:midday" — once per day per slot. */
  key: string;
  slotMs: number;
}

/**
 * The slot that is due at `nowMs`, if any: its local time has passed today
 * and it is still inside CHECKIN_WINDOW_MS. The latest such slot wins, so a
 * missed 12:30 never fires late after the 17:30 one is due.
 */
export function dueCheckin(persona: Persona, nowMs: number, timezone: string): DueCheckin | null {
  const today = localDate(nowMs, timezone);
  let due: DueCheckin | null = null;
  for (const slot of persona.checkins) {
    const slotMs = toEpochMs(`${today}T${slot.time}`, timezone);
    if (nowMs >= slotMs && nowMs < slotMs + CHECKIN_WINDOW_MS) {
      due = { slot, key: `${today}:${persona.id}:${slot.id}`, slotMs };
    }
  }
  return due;
}

export type CheckinDecision =
  | { send: true; due: DueCheckin }
  | { send: false; reason: "off" | "no_slot" | "user_active" | "too_soon" };

/**
 * Everything about WHETHER to check in, as one pure decision. Dedupe of the
 * exact slot (once per day) is the caller's claim mutation — this only
 * decides whether to try.
 */
export function decideCheckin(args: {
  persona: Persona;
  enabled: boolean;
  nowMs: number;
  timezone: string;
  lastInboundMs?: number;
  lastCheckinMs?: number;
}): CheckinDecision {
  if (!args.enabled) return { send: false, reason: "off" };
  const due = dueCheckin(args.persona, args.nowMs, args.timezone);
  if (!due) return { send: false, reason: "no_slot" };
  if (
    args.lastCheckinMs !== undefined &&
    args.nowMs - args.lastCheckinMs < args.persona.minGapMinutes * 60_000
  ) {
    return { send: false, reason: "too_soon" };
  }
  if (args.lastInboundMs !== undefined && args.nowMs - args.lastInboundMs < CHECKIN_QUIET_AFTER_USER_MS) {
    return { send: false, reason: "user_active" };
  }
  return { send: true, due };
}

/** Minutes since local midnight for "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local minutes since midnight at `atMs`. */
function localMinutes(atMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

/** A stable 0..1 number for a day, so the jitter moves day to day but not tick to tick. */
export function daySeed(date: string): number {
  let h = 2166136261;
  for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

export interface WatchEvent {
  id: string;
  title: string;
  startMs: number;
}

export interface WatchTask {
  /** "THE-89 Item notes in the order payload" */
  title: string;
  status: string;
  /** ms-epoch, when the task has a due date. */
  dueMs?: number;
}

/**
 * How long the user may stay quiet before a watching persona asks for an
 * update: idleMinutes, minus perTaskMinutes for each in-progress or
 * due-today task, never under the floor, plus the day's jitter.
 */
export function idleThresholdMinutes(
  watch: WatchConfig,
  pressure: number,
  seed: number,
): number {
  const base = Math.max(watch.idleFloorMinutes, watch.idleMinutes - pressure * watch.perTaskMinutes);
  return Math.round(base + seed * watch.jitterMinutes);
}

export type WatchDecision =
  | { send: true; key: string; slot: CheckinSlot }
  | { send: false; reason: "no_watch" | "off" | "outside_hours" | "user_active" | "too_soon" | "nothing" };

/**
 * The Corporate PA's in-between check-ins, as one pure decision. Runs on
 * every tick that no fixed slot claimed. Dedupe (once per event, once per
 * quiet stretch) is the caller's claim on `key`.
 */
export function decideWatch(args: {
  persona: Persona;
  enabled: boolean;
  nowMs: number;
  timezone: string;
  lastInboundMs?: number;
  lastCheckinMs?: number;
  events: WatchEvent[];
  tasks: WatchTask[];
  endOfTodayMs: number;
}): WatchDecision {
  const watch = args.persona.watch;
  if (!watch) return { send: false, reason: "no_watch" };
  if (!args.enabled) return { send: false, reason: "off" };
  const local = localMinutes(args.nowMs, args.timezone);
  if (local < minutesOf(watch.from) || local >= minutesOf(watch.until)) {
    return { send: false, reason: "outside_hours" };
  }
  if (
    args.lastCheckinMs !== undefined &&
    args.nowMs - args.lastCheckinMs < args.persona.minGapMinutes * 60_000
  ) {
    return { send: false, reason: "too_soon" };
  }
  if (args.lastInboundMs !== undefined && args.nowMs - args.lastInboundMs < CHECKIN_QUIET_AFTER_USER_MS) {
    return { send: false, reason: "user_active" };
  }

  // 1. Something starts soon: make sure they are ready for it.
  const leadMs = watch.eventLeadMinutes * 60_000;
  const upcoming = args.events
    .filter((e) => e.startMs - args.nowMs >= leadMs - 15 * 60_000 && e.startMs - args.nowMs <= leadMs + 15 * 60_000)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (upcoming) {
    return {
      send: true,
      key: `watch:event:${upcoming.id}:${upcoming.startMs}`,
      slot: {
        id: "event",
        time: "",
        purpose: `"${upcoming.title}" starts in about ${Math.round((upcoming.startMs - args.nowMs) / 60_000)} minutes. Ask one thing: whether they will be joining it.`,
      },
    };
  }

  // 2. Quiet too long with work open: ask about the specific task.
  const open = args.tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED");
  if (open.length === 0) return { send: false, reason: "nothing" };
  const pressing = open.filter(
    (t) =>
      t.status === "IN_PROGRESS" ||
      t.status === "RESUMED" ||
      (t.dueMs !== undefined && t.dueMs < args.endOfTodayMs),
  );
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: args.timezone }).format(new Date(args.nowMs));
  const thresholdMs = idleThresholdMinutes(watch, pressing.length, daySeed(date)) * 60_000;
  // Quiet since the later of: their last message, the last check-in, or
  // the start of the watch window today.
  const windowStartMs = args.nowMs - (local - minutesOf(watch.from)) * 60_000;
  const quietSince = Math.max(args.lastInboundMs ?? 0, args.lastCheckinMs ?? 0, windowStartMs);
  if (args.nowMs - quietSince < thresholdMs) return { send: false, reason: "nothing" };

  const focus = pressing[0] ?? open[0]!;
  return {
    send: true,
    key: `watch:idle:${date}:${quietSince}`,
    slot: {
      id: "idle",
      time: "",
      purpose: `No update from them in a while. Ask one thing: whether "${focus.title}" is complete.`,
    },
  };
}

/**
 * The composer's instructions for one unprompted check-in. The facts block
 * (the same one the morning check-in reads) is the model's input; this is
 * its system prompt, minus the invariants briefs.ts appends.
 */
export function checkinInstructions(persona: Persona, slot: CheckinSlot, nowLabel: string): string {
  const shape = persona.multiAsk
    ? `Shape — a short, direct status request:
1. One line saying why you are checking in (e.g. "Stand-up." / "Afternoon status.").
2. Up to three items, one per line, each a direct ask about ONE task by its
   identifier ("THE-89 — status? ETA?"). Nothing else on those lines.
No greeting beyond a word, no commentary, no motivational lines.`
    : `Shape — ONE purpose, ONE question. Two lines at most:
1. Why you are checking in, in a few words, with the one fact the question
   needs (the task by identifier and title, or the meeting by time and name).
2. ONE question they can answer in a word or two.
Never ask a second question. Never mix topics: no "how's your day" next to a
task push, no extra reminder about a different task or meeting.`;

  return `${personaVoiceBlock(persona)}

You are checking in on the user WITHOUT being asked. It is ${nowLabel}.
Purpose of this check-in: ${slot.purpose}

${shape}

Use only what is still ahead today: never ask about a meeting that has
already ended. If the facts give you nothing for this purpose, ask the
purpose's question in general terms (e.g. "What are you working on first?").`;
}
