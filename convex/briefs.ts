import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { reportIncident } from "./ops";
import { sendMorningBeforeBrief } from "./scripture";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { sendMessage } from "./channels/telegram";
import { formatInstant, toEpochMs } from "./lib/time";
import { nextOccurrenceOf } from "./model/briefConfig";
import { TELEGRAM_FORMAT_CONTRACT } from "./lib/prompts/format";
import { MORNING_CHECKIN } from "./lib/prompts/brief";
import { buildKnowledgeBlock } from "./lib/prompts/knowledge";
import { normalizeCategory } from "./lib/userContext";
import { backendForAccounts, hasBlockerNote, blockerReason } from "./lib/tasks/backend";
import {
  allCalendarEvents,
  listOpenLinearIssues,
  listOpenLinearIssuesWithDescriptions,
  toCalendarItems,
} from "./tools/router";
import { dayWindow } from "./lib/calendar/window";
import {
  CHECKINS_PREF_KEY,
  PERSONA_PREF_KEY,
  checkinInstructions,
  checkinsEnabled,
  personaOrDefault,
  personaVoiceBlock,
  type CheckinSlot,
  type Persona,
} from "./lib/personas";

/* ── Pure: gathering + formatting. No ctx, no fetch — bun test runs this
   with no Convex runtime, same boundary as everything in convex/lib/. ── */

export interface BriefTask {
  title: string;
  status: string;
  dueAt?: number;
}

export interface BriefBlocker {
  taskTitle: string;
  description: string;
  expectedAt?: number;
}

export interface BriefReminder {
  message: string;
  scheduledAt: number;
}

export interface BriefProject {
  name: string;
  status: string;
}

export interface BriefEmail {
  from: string;
  subject: string;
  importance?: string;
  labelIds: string[];
  inSpam: boolean;
  /** ms-epoch — filtered against the brief's rolling window. */
  receivedAt: number;
  /** True when a real-time alert already covered this thread (Phase 5) — the
   *  brief must not re-surface it, or the assistant reads as having no
   *  memory of what it already told the user. */
  alreadyAlerted: boolean;
}

/**
 * Non-promotional, non-social, CRITICAL or HIGH only, received within
 * `[sinceMs, untilMs)`, and not already pushed as a real-time alert. A
 * message Phase 4 hasn't classified yet (`importance` is `undefined`) is
 * excluded, not defaulted to anything — a daily brief is not the place to
 * guess.
 */
export function filterBriefEmails(
  emails: BriefEmail[],
  sinceMs: number,
  untilMs: number,
): BriefEmail[] {
  return emails.filter((e) => {
    if (e.receivedAt < sinceMs || e.receivedAt >= untilMs) return false;
    if (e.alreadyAlerted) return false;
    if (e.labelIds.includes("CATEGORY_PROMOTIONS")) return false;
    if (e.labelIds.includes("CATEGORY_SOCIAL")) return false;
    return e.importance === "CRITICAL" || e.importance === "HIGH";
  });
}

/**
 * Midnight of the day before `nowMs`, in `timezone`. Pure — no wall-clock
 * read inside; the caller passes `Date.now()` in explicitly, same discipline
 * as everywhere else time enters this codebase (see `lib/time.ts`'s guidance
 * against reading the clock inside a query).
 */
export function sinceYesterdayMidnight(nowMs: number, timezone: string): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
    .format(new Date(nowMs - oneDayMs)); // en-CA gives YYYY-MM-DD directly
  return toEpochMs(`${localDate}T00:00`, timezone);
}

export interface BriefFactsInput {
  timezone: string;
  /** The start of this brief's email window — rendered into the header so
   *  the model (and the reader) know exactly what "since" means today. */
  sinceMs: number;
  notes?: string;
  tasks: BriefTask[];
  blockers: BriefBlocker[];
  reminders: BriefReminder[];
  projects: BriefProject[];
  emails: BriefEmail[];
  /** Today's events across every connected calendar. */
  calendar?: BriefEvent[];
  /** Set when the calendar could not be read, so the brief says so. */
  calendarNote?: string;
  /** ms-epoch of "now", so overdue and due-today can be told apart. */
  nowMs?: number;
}

export interface BriefEvent {
  title: string;
  startMs: number;
  endMs: number;
  allDay?: boolean;
}

/**
 * Order tasks the way the "first thing" is chosen (docs/BEHAVIOUR.md §5):
 * overdue, then due today, then in progress, then everything else.
 */
export function rankBriefTasks(tasks: BriefTask[], nowMs: number, endOfTodayMs: number): BriefTask[] {
  const rank = (t: BriefTask) => {
    if (t.dueAt !== undefined && t.dueAt < nowMs) return 0;
    if (t.dueAt !== undefined && t.dueAt < endOfTodayMs) return 1;
    if (t.status === "IN_PROGRESS" || t.status === "RESUMED") return 2;
    if (t.status === "BLOCKED") return 4;
    return 3;
  };
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
}

/**
 * Structured facts → one plain-text block, the `input` handed to the
 * COMPOSE_BRIEF model call. Never raw email bodies, never anything with more
 * detail than a brief needs — the model gets a subject line and a sender,
 * not a message body it could be manipulated by.
 */
export function renderBriefFacts(facts: BriefFactsInput): string {
  const open = facts.tasks.filter(
    (t) => t.status !== "COMPLETED" && t.status !== "CANCELLED",
  );
  const lines: string[] = [];

  if (facts.calendar !== undefined || facts.calendarNote) {
    lines.push("TODAY'S CALENDAR (every connected calendar)");
    const events = facts.calendar ?? [];
    lines.push(
      events.length === 0
        ? `  ${facts.calendarNote ?? "(nothing scheduled)"}`
        : events
            .map((e) =>
              e.allDay
                ? `  - all day — ${e.title}`
                : `  - ${formatInstant(e.startMs, facts.timezone)} → ${formatInstant(e.endMs, facts.timezone)} — ${e.title}`,
            )
            .join("\n") + (facts.calendarNote ? `\n  (${facts.calendarNote})` : ""),
    );
    lines.push("");
  }

  lines.push("OPEN TASKS (most urgent first)");
  lines.push(
    open.length === 0
      ? "  (none)"
      : open
          .map(
            (t) =>
              `  - ${t.title} — ${t.status}${
                t.dueAt === undefined ? "" : `, due ${formatInstant(t.dueAt, facts.timezone)}`
              }`,
          )
          .join("\n"),
  );

  lines.push("", "BLOCKED");
  lines.push(
    facts.blockers.length === 0
      ? "  (none)"
      : facts.blockers
          .map(
            (b) =>
              `  - ${b.taskTitle} ← ${b.description}${
                b.expectedAt === undefined
                  ? ""
                  : `, expected ${formatInstant(b.expectedAt, facts.timezone)}`
              }`,
          )
          .join("\n"),
  );

  lines.push("", "REMINDERS PENDING");
  lines.push(
    facts.reminders.length === 0
      ? "  (none)"
      : facts.reminders
          .map((r) => `  - ${formatInstant(r.scheduledAt, facts.timezone)} — ${r.message}`)
          .join("\n"),
  );

  lines.push("", "ACTIVE PROJECTS");
  lines.push(
    facts.projects.length === 0
      ? "  (none)"
      : facts.projects.map((p) => `  - ${p.name} — ${p.status}`).join("\n"),
  );

  lines.push(
    "",
    `IMPORTANT EMAIL SINCE ${formatInstant(facts.sinceMs, facts.timezone)} ` +
      "(non-promotional, CRITICAL/HIGH, not already sent to you as an alert)",
  );
  lines.push(
    facts.emails.length === 0
      ? "  (none)"
      : facts.emails
          .map(
            (e) =>
              `  - [${e.importance}] ${e.from} — "${e.subject}"${
                e.inSpam ? " (found in SPAM)" : ""
              }`,
          )
          .join("\n"),
  );

  lines.push("", "OWNER'S NOTES ON WHAT TO COVER");
  lines.push(`  ${facts.notes?.trim() || "(none — use judgement)"}`);

  return lines.join("\n");
}

/* ── Actions: real data, the model call, delivery. ── */

/**
 * Rules that hold no matter what the user's skill says. A skill governs
 * FORMAT and EMPHASIS; it cannot authorise inventing a fact or conjure a data
 * source that is not connected. Appended last so they are read last.
 */
const COMPOSE_INVARIANTS = `
NON-NEGOTIABLE, regardless of any instruction above:
- Every TASK, EMAIL, MEETING, REMINDER, BLOCKER, PERSON, date and deadline
  you mention must appear in the FACTS block. Never invent one, never infer a
  completion, never upgrade a maybe into a certainty.
- What you know about the user — routines, preferences, standing
  instructions, shown at the top — is also true, and something they asked to
  see in the morning should appear, in one line.
- No news or web data exists. Never imply you checked any.
- Mention a calendar only from the TODAY'S CALENDAR facts. If that section is
  absent, say nothing about meetings.

${TELEGRAM_FORMAT_CONTRACT}`;

/** The active personality and whether it may check in unprompted. */
export async function loadPersona(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ persona: Persona; checkinsOn: boolean }> {
  const [stored, checkins] = await Promise.all([
    ctx.runQuery(internal.model.preferences.get, { userId, key: PERSONA_PREF_KEY }),
    ctx.runQuery(internal.model.preferences.get, { userId, key: CHECKINS_PREF_KEY }),
  ]);
  return { persona: personaOrDefault(stored), checkinsOn: checkinsEnabled(checkins) };
}

/**
 * Everything the morning check-in and the personality check-ins read: the
 * FACTS block and the user's knowledge block. One gatherer, so a check-in
 * can never see less than the morning message does.
 */
async function gatherFacts(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ facts: BriefFactsInput; knowledge: string }> {
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";

  // instructions and userContext are in this list because they were NOT,
  // and the brief was blind to everything the user had taught it about
  // themselves — see MEMORY.md 2026-08-23. `/brief` and the scheduled 07:00
  // delivery share this function, so both were affected.
  const [config, tasksRaw, blockersRaw, reminders, projects, accounts, instructions, userContext] =
    await Promise.all([
      ctx.runQuery(internal.model.briefConfig.get, { userId }),
      ctx.runQuery(internal.model.tasks.list, { userId, limit: 25 }),
      ctx.runQuery(internal.model.tasks.openBlockers, { userId }),
      ctx.runQuery(internal.model.reminders.listPending, { userId }),
      ctx.runQuery(internal.model.projects.listActive, { userId, limit: 15 }),
      ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId }),
      ctx.runQuery(internal.model.instructions.list, { userId }),
      ctx.runQuery(internal.model.userContext.list, { userId }),
    ]);

  const untilMs = Date.now();
  const sinceMs = sinceYesterdayMidnight(untilMs, timezone);

  // The brief must show the board the user actually works from. It read only
  // the Convex table, so once Linear owned the tasks the morning brief
  // quietly reported "(none)" every day — the worst kind of wrong, because
  // an empty list looks like an answer.
  const taskBackendKind = backendForAccounts(accounts);

  let tasks: { title: string; status: string; dueAt?: number }[] = tasksRaw.map((t) => ({
    title: t.title,
    status: t.status,
    dueAt: t.dueAt,
  }));

  let blockers: BriefBlocker[] = blockersRaw.flatMap(({ task, blockers: bs }) =>
    bs.map((b) => ({ taskTitle: task.title, description: b.description, expectedAt: b.expectedAt })),
  );

  if (taskBackendKind === "linear") {
    try {
      const issues = await listOpenLinearIssues(ctx, userId, 25);
      tasks = issues.map((i) => ({ title: `${i.taskId} ${i.title}`, status: i.status }));
      // Blockers on Linear live in the issue description, not the Convex
      // table — the brief used to read the table and show stale blockers.
      const described = await listOpenLinearIssuesWithDescriptions(ctx, userId, 25);
      blockers = described
        .filter((i) => hasBlockerNote(i.description))
        .map((i) => ({
          taskTitle: `${i.identifier} ${i.title}`,
          description: blockerReason(i.description) ?? "blocked",
        }));
    } catch (error) {
      // A Linear outage must not silently render as an empty board — say it.
      console.warn(`brief_linear_load_failed: ${String(error)}`);
      tasks = [{ title: "(could not reach Linear — board not shown)", status: "UNKNOWN" }];
      blockers = [];
    }
  }

  // Today's calendar, every connected account. A failure is reported in the
  // brief, never silently rendered as "nothing scheduled".
  let calendar: BriefEvent[] | undefined;
  let calendarNote: string | undefined;
  try {
    const today = dayWindow(untilMs, timezone);
    const found = await allCalendarEvents(ctx, userId, today, { limit: 25 });
    calendar = toCalendarItems(found.events, timezone).map((e) => ({
      title: e.title,
      startMs: e.startMs,
      endMs: e.endMs,
      allDay: e.allDay,
    }));
    if (found.failures.length > 0) {
      calendarNote = `could not read ${found.failures.length} calendar(s)`;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    calendarNote = detail.includes("Calendar access")
      ? "calendar not connected yet — reconnect the mailbox to include it"
      : "calendar could not be read this morning";
  }

  const endOfToday = dayWindow(untilMs, timezone).endMs;
  tasks = rankBriefTasks(tasks, untilMs, endOfToday);

  const accountIds = accounts.filter((a) => a.status === "ACTIVE").map((a) => a._id);
  // limit:50, not 25 — this is filtered by TIME after fetching, so it must
  // fetch enough to actually cover a ~30-hour window, not just "recent 25".
  const emailsRaw =
    accountIds.length === 0
      ? []
      : await ctx.runQuery(internal.model.emailMessages.search, { accountIds, limit: 50 });

  // Was a real-time alert already sent for this thread? One lookup per
  // candidate email — the list is already narrowed to ~50 rows by the query
  // above, so this stays cheap. Reuses Phase 5's existing notifications
  // query rather than adding a new one.
  const alreadyAlertedByThread = new Map<string, boolean>();
  for (const m of emailsRaw) {
    if (alreadyAlertedByThread.has(m.threadId)) continue;
    const existing = await ctx.runQuery(internal.model.notifications.findByThreadKey, {
      threadKey: m.threadId,
    });
    alreadyAlertedByThread.set(m.threadId, existing !== null);
  }

  const facts: BriefFactsInput = {
    timezone,
    sinceMs,
    notes: config.notes,
    tasks: tasks.slice(0, 12),
    blockers,
    calendar,
    calendarNote,
    nowMs: untilMs,
    reminders: reminders.map((r) => ({ message: r.message, scheduledAt: r.scheduledAt })),
    projects: projects.map((p) => ({ name: p.name, status: p.status })),
    emails: filterBriefEmails(
      emailsRaw.map((m) => ({
        from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
        subject: m.subject ?? "(no subject)",
        importance: m.importance,
        labelIds: m.labelIds,
        inSpam: m.labelIds.includes("SPAM"),
        receivedAt: m.receivedAt,
        alreadyAlerted: alreadyAlertedByThread.get(m.threadId) ?? false,
      })),
      sinceMs,
      untilMs,
    ).slice(0, 10),
  };

  // Order is load-bearing: what the user has TAUGHT comes first, the skill
  // (which they also author) governs shape, and the invariants land last so
  // nothing above can license inventing a fact or a data source.
  const knowledge = buildKnowledgeBlock({
    // The column is a plain string; normalizeCategory is the boundary that
    // turns it back into the union, filing anything unrecognised under
    // "other" rather than dropping a fact the user volunteered.
    userContext: userContext.map((c) => ({
      category: normalizeCategory(c.category),
      text: c.text,
    })),
    customInstructions: instructions.map((i) => i.text),
  });

  return { facts, knowledge };
}

async function gatherAndCompose(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const [{ facts, knowledge }, { persona }] = await Promise.all([
    gatherFacts(ctx, userId),
    loadPersona(ctx, userId),
  ]);

  // The user's morning_brief skill governs the brief's shape. Falls back to
  // MORNING_CHECKIN when no skill exists, so this works before anyone
  // writes one — and the invariants are appended either way. The
  // personality sets the voice; the skill still sets the shape.
  const skill = await ctx.runQuery(internal.model.skills.getEffective, {
    userId,
    name: "morning_brief",
  });

  const result = await runTask("COMPOSE_BRIEF", {
    system: `${knowledge}\n\n${personaVoiceBlock(persona)}\n\n${skill?.content ?? MORNING_CHECKIN}\n${COMPOSE_INVARIANTS}`,
    input: renderBriefFacts(facts),
    maxOutputTokens: 800,
  });

  return result.text.trim();
}

/**
 * One unprompted personality check-in (convex/checkins.ts). Same facts and
 * the same invariants as the morning message; the personality's slot
 * decides what it is for.
 */
export async function composeCheckin(
  ctx: ActionCtx,
  userId: Id<"users">,
  persona: Persona,
  slot: CheckinSlot,
): Promise<string> {
  const { facts, knowledge } = await gatherFacts(ctx, userId);
  const nowLabel = formatInstant(facts.nowMs ?? Date.now(), facts.timezone);
  const result = await runTask("COMPOSE_BRIEF", {
    system: `${knowledge}\n\n${checkinInstructions(persona, slot, nowLabel)}\n${COMPOSE_INVARIANTS}`,
    input: renderBriefFacts(facts),
    maxOutputTokens: 500,
  });
  return result.text.trim();
}

/**
 * On-demand composition. `/brief` and the `brief.preview` tool both call
 * this directly. Read-only over everything it gathers; never touches the
 * schedule.
 */
export const compose = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await gatherAndCompose(ctx, args.userId),
});

/**
 * The scheduler's target — mirrors `convex/reminders.ts`'s `deliver` shape,
 * plus the one thing reminders never need: rescheduling itself. That final
 * step is what turns a single `runAt` call into a standing daily habit with
 * no cron and no redeploy.
 */
export const deliver = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const config = await ctx.runQuery(internal.model.briefConfig.get, { userId: args.userId });
    if (!config.enabled) return; // turned off between schedule and fire

    const user = await ctx.runQuery(internal.model.users.get, { userId: args.userId });
    if (!user) return;

    // The day opens with thanks before tasks: the morning verse first, once.
    await sendMorningBeforeBrief(ctx, args.userId);

    let text: string;
    let outboundId: string;
    try {
      text = await gatherAndCompose(ctx, args.userId);
      outboundId = await sendMessage(user.telegramId, text);
    } catch (error) {
      // The check-in silently not arriving is the failure the owner would
      // otherwise only notice at lunch. Report, then rethrow so the
      // ensureScheduled sweep still repairs the chain.
      await reportIncident(ctx, { source: "brief.deliver", error, severity: "critical" });
      throw error;
    }

    await ctx.runMutation(internal.model.messages.record, {
      userId: args.userId,
      channel: "telegram",
      direction: "out",
      channelMessageId: outboundId,
      kind: "text",
      text,
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "scheduler",
      action: "brief.deliver",
      args: { chars: text.length },
      result: "ok",
    });

    // Reschedule for +24h — the self-perpetuating chain. Lagos has no DST
    // (see the note in crons.ts), so a flat +24h never drifts against the
    // configured wall-clock time. If this step never runs at all — the
    // action above threw before reaching here — ensureScheduled's daily
    // sweep notices the config is enabled with no live scheduledJobId and
    // repairs it.
    await ctx.runMutation(internal.model.briefConfig.reschedule, {
      userId: args.userId,
      nextAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  },
});

/**
 * Daily safety net — same shape and same reason to exist as
 * `reminders.reconcile`. Scheduled jobs are durable, so in the ordinary case
 * this finds an enabled config with a live `scheduledJobId` and does
 * nothing. It only acts when the chain broke: an uncaught error in
 * `deliver` before it reached the reschedule step, or a `scheduledJobId`
 * cleared some other way.
 */
export const ensureScheduled = internalAction({
  args: {},
  handler: async (ctx) => {
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!ownerId) return;

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, {
      telegramId: ownerId,
    });
    if (!user) return;

    const config = await ctx.runQuery(internal.model.briefConfig.get, { userId: user._id });
    if (!config.enabled || config.scheduledJobId) return;

    console.warn(`brief_schedule_missing: user ${user._id}`);
    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    await ctx.runMutation(internal.model.briefConfig.reschedule, {
      userId: user._id,
      nextAt: nextOccurrenceOf(config.timeOfDay, timezone),
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "scheduler",
      action: "brief.ensure_scheduled",
      args: { repaired: true },
      result: "ok",
    });
  },
});
