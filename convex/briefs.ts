import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { sendMessage } from "./channels/telegram";
import { formatInstant, toEpochMs } from "./lib/time";
import { nextOccurrenceOf } from "./model/briefConfig";
import { TELEGRAM_FORMAT_CONTRACT } from "./lib/prompts/format";
import { buildKnowledgeBlock } from "./lib/prompts/knowledge";
import { normalizeCategory } from "./lib/userContext";
import { pickBackend } from "./lib/tasks/backend";
import { listOpenLinearIssues } from "./tools/router";

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

  lines.push("OPEN TASKS");
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

const COMPOSE_FALLBACK = `You write Adedotun's daily morning brief for Telegram.

Turn the structured facts you're given into short, scannable prose — not a
recitation of every field. Follow this shape:

Good morning.

TODAY'S ONE THING
  <the single most important open task or blocked item, one line>

NEEDS YOU
  <important email, one line each, ⚠️ if it was found in SPAM>

BLOCKED
  <each blocker, what it's waiting on and on whom, if given>

Omit a section entirely if its facts said (none) — do not write "(none)" or
"nothing here" in your output, that placeholder was for you to see, not the
reader.

There is NO calendar in this build. Never mention checking a calendar,
today's meetings, or scheduling around events — you were not given any
calendar data because none exists yet, not because it was left out today.

Never invent a task, email, deadline, or person that was not in the facts.
If the facts are empty everywhere, say plainly that there's nothing new and
stop — do not pad the message.`;

/**
 * Rules that hold no matter what the user's skill says.
 *
 * A skill governs FORMAT and EMPHASIS — how much to show, in what order,
 * under which headings. It cannot authorise inventing a fact, and it cannot
 * conjure a data source that is not connected. Those two are appended after
 * the skill so they are the last thing the model reads.
 */
const COMPOSE_INVARIANTS = `
NON-NEGOTIABLE, regardless of any instruction above:
- Every TASK, EMAIL, REMINDER, BLOCKER, PERSON, date and deadline you mention
  must appear in the FACTS block. Never invent one, never infer a completion,
  never upgrade a maybe into a certainty.
- That rule is about FACTS OF RECORD, not about the user themselves. What you
  know about the user — their routines, preferences and standing instructions,
  shown at the top — is also true, and anything they have asked to see in this
  brief MUST appear even though it is not in the FACTS block. A preference
  like "remind me about my Sunday routine" is an instruction to include it,
  not a fact to verify.
  When such a preference exists, EMIT A SECTION FOR IT even if the procedure
  above lists no such section — add "PERSONAL" at the end and put it there.
  A procedure defines the default shape of the brief; a direct request from
  the user outranks that shape. Omitting what they explicitly asked to see
  because your template had no slot for it is the wrong trade every time.
- Only these data sources are connected right now: tasks, projects, blockers,
  reminders, people, and Gmail. There is NO calendar and NO news/web search in
  this build. Omit those sections entirely — never imply you checked them, and
  never emit a "Calendar" heading saying "nothing scheduled", which reads as
  though a calendar were connected and empty.
- The FACTS block is the complete picture for the categories it covers. If it
  lists five open tasks, all five are still open; do not silently drop any
  because they seem minor.

${TELEGRAM_FORMAT_CONTRACT}`;

async function gatherAndCompose(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
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
  const taskBackendKind = pickBackend(
    accounts.some((a) => a.provider === "linear" && a.status === "ACTIVE"),
  );

  let tasks: { title: string; status: string; dueAt?: number }[] = tasksRaw.map((t) => ({
    title: t.title,
    status: t.status,
    dueAt: t.dueAt,
  }));

  if (taskBackendKind === "linear") {
    try {
      const issues = await listOpenLinearIssues(ctx, userId, 25);
      tasks = issues.map((i) => ({ title: `${i.taskId} ${i.title}`, status: i.status }));
    } catch (error) {
      // A Linear outage must not silently render as an empty board — say it.
      console.warn(`brief_linear_load_failed: ${String(error)}`);
      tasks = [{ title: "(could not reach Linear — board not shown)", status: "UNKNOWN" }];
    }
  }

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
    tasks,
    blockers: blockersRaw.flatMap(({ task, blockers }) =>
      blockers.map((b) => ({
        taskTitle: task.title,
        description: b.description,
        expectedAt: b.expectedAt,
      })),
    ),
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

  // The user's morning_brief skill governs the brief's shape. Falls back to
  // COMPOSE_FALLBACK when no skill exists, so this works before anyone
  // writes one — and the invariants are appended either way.
  const skill = await ctx.runQuery(internal.model.skills.getEffective, {
    userId,
    name: "morning_brief",
  });

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

  const result = await runTask("COMPOSE_BRIEF", {
    system: `${knowledge}\n\n${skill?.content ?? COMPOSE_FALLBACK}\n${COMPOSE_INVARIANTS}`,
    input: renderBriefFacts(facts),
    maxOutputTokens: 3000,
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

    const text = await gatherAndCompose(ctx, args.userId);
    const outboundId = await sendMessage(user.telegramId, text);

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
