# Phase 5B — The morning brief, configured by talking to the bot

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Design reference:** `alright-so-as-part-tender-glade.md` → *PHASE-05B — Morning brief*
- **Prose format reference:** `docs/personal-ai-assistant-build-plan-v3-convex.md` → *Phase 12 — The unified morning brief* (the "Good morning..." mock — this doc reuses its shape, minus CALENDAR)
- **Prerequisite:** Phase 2 (tasks, reminders, projects, the tool router) and Phase 3 (Gmail sync) complete, so there is something to summarize. Phase 4 (importance classification) is not a hard prerequisite to *build* this — it typechecks and deploys without it — but until Phase 4 exists, `emailMessages.importance` is `undefined` on every row, so the brief's email section is always empty. That's not a bug in this doc; it's Phase 4's job to fill in.
- **Not in the source plan.** The v3 build plan's Phase 12 sends the brief from a fixed `crons.cron("morning brief", "0 6 * * *", ...)`. This doc deliberately does not do that — see "Why `runAt`, not `cron`" below.

---

## What you'll have at the end

You say to the bot, in plain language, something like *"send me a morning recap every day at 7, just tasks, reminders, and non-promotional important email"* — and it configures itself. The brief arrives at that time, every day, without you touching a file or redeploying. You say *"make it 8 instead"* and the very next one moves, provably (the stored scheduled-job id changes). You say *"turn it off"* and it stops. `/brief` gets you one right now, on demand, whether or not the daily one is even turned on.

---

## Why `runAt`, not `cron`

`convex/crons.ts` already has two crons — a reminder-reconcile sweep and Gmail sync — and both are *fixed*: their schedule lives in a string literal, in a file, that only changes on a deploy. That's fine for infrastructure hygiene (nobody needs to reconfigure "sync every 10 minutes" by chatting with a bot). It is wrong for a morning brief, because the whole point of a morning brief is that the *time* is a personal preference, and "no code edits for a routine change" was the actual ask.

This codebase already has the right pattern for a personal, editable, exact-time event: `convex/model/reminders.ts`. A reminder's `create` mutation computes the target instant, calls `ctx.scheduler.runAt(instant, internal.reminders.deliver, {...})`, and stores the returned job id on the row so it can be cancelled and rescheduled later. That's not a poll — Convex invokes `deliver` at that exact instant, once, durably. This doc reuses that exact mechanism for the brief:

- `briefConfig.configure` (a mutation, mirroring `reminders.create`) computes the next occurrence of the configured `timeOfDay`, cancels whatever was scheduled before, and `runAt`s the new one — storing the job id. Changing the time via chat is *calling this mutation again*.
- Reminders don't repeat, so `reminders.deliver` never reschedules itself. A brief does — `briefs.deliver` sends the message, then immediately schedules tomorrow's occurrence and stores the new job id. One `runAt` call perpetuates itself into a standing daily habit, forever, with no cron in the loop at all.
- The one cron this doc adds, `internal.briefs.ensureScheduled`, is not what delivers the brief. It's a safety net — the same shape as the existing `reconcile missed reminders` cron — that runs once a day and only ever does something if the self-scheduling chain broke (an enabled config with no live job id).

If you ever catch yourself about to write `crons.cron("morning brief", "0 6 * * *", ...)`, that's the fixed-cron design this doc exists to avoid — it would work today and become wrong the first time you wanted to change the time.

**Scope-honesty note, stated once, up front:** the source plan's Phase 12 mock includes a `CALENDAR` section. Calendar (source Phase 10) is not built in this project. The prose format below is that mock with `CALENDAR` removed, not silently — the compose prompt is told explicitly that no calendar exists, so it never invents one.

**The email section has a real, stated time window — not "whatever's cached."** The brief covers **midnight yesterday (in `USER_TIMEZONE`) through the moment it's composed** — a Saturday brief covers Friday 00:00 through Saturday's send time; Sunday's covers Saturday 00:00 through Sunday's send time. This is computed fresh from `Date.now()` and the timezone every time, not stored — a brief that's late or skipped one day does not retroactively expand the next day's window, which is a deliberate simplicity trade-off over tracking `lastDeliveredAt` state that could itself drift or double-count on a retry.

**The email section also excludes anything already pushed as a real-time alert.** Phase 5's delivery rule already sends `CRITICAL` immediately and `HIGH` immediately during waking hours — by the time the brief runs, those may already be sitting in the user's chat. Re-surfacing them here would read as the assistant not remembering its own actions. The brief's email section is therefore exactly "what CRITICAL/HIGH mail arrived since midnight that has *not* already been delivered" — checked via `convex/model/notifications.ts`'s existing `findByThreadKey` (Phase 5), keyed on the email's `threadId`.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
| --- | --- | --- | --- |
| 1 | `convex/model/briefConfig.ts` | new | Thin typed wrapper over the existing `preferences` table — the schedule's state and the `runAt`/cancel logic |
| 2 | `convex/lib/tools/catalog.ts` | edit | `brief.configure`, `brief.preview` — the tool contract |
| 3 | `convex/tools/router.ts` | edit | Wires those two tools to `briefConfig` and `briefs.compose` |
| 4 | `convex/lib/tools/outcomes.ts` | edit | Turns their results into the sentence the user reads |
| 5 | `tests/unit/brief-compose.test.ts` | new | The failing test for `briefs.ts`'s pure gather/format logic |
| 6 | `convex/briefs.ts` | new | `compose` / `deliver` / `ensureScheduled` — the whole feature |
| 7 | `convex/crons.ts` | edit | One daily safety-net cron |
| 8 | `convex/assistant.ts` | edit | `/brief` — the on-demand command |

No `schema.ts` edit. The `preferences` table already exists (added ahead of its phase, currently unused anywhere) with exactly the shape this needs: `{ userId, key, value }`. `briefConfig.ts` stores everything under one fixed `key: "morning_brief"`.

---

## Step 1 — The schedule's state and its `runAt` logic

**File:** `convex/model/briefConfig.ts` **(create)**

**What this file is for.** Everything about *whether* the brief runs and *when* — read, and the mutation that is the entire reason it's chat-editable. It mirrors `convex/model/reminders.ts`'s `create` almost line for line: compute the instant, `runAt` it, store the job id. The one addition is that it also *cancels* whatever was scheduled under the old config first, because leaving a stale job in place would fire the old time alongside the new one — two briefs a day, forever, at two different times.

```ts
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { toEpochMs } from "../lib/time";

/**
 * Wraps the existing (until now unused) `preferences` table under one fixed
 * key. No new table — the same "don't reinvent what already exists" instinct
 * this codebase already applies to `customInstructions`.
 */
const KEY = "morning_brief";

export interface BriefConfig {
  enabled: boolean;
  /** 24-hour local time, "HH:MM", in the user's timezone. */
  timeOfDay: string;
  notes?: string;
  /** Set whenever a delivery is actually scheduled; unset while disabled. */
  scheduledJobId?: Id<"_scheduled_functions">;
}

const DEFAULT_CONFIG: BriefConfig = { enabled: false, timeOfDay: "07:00" };

/**
 * The next ms-epoch occurrence of `timeOfDay` in `timezone`, from `fromMs`.
 * Rolls to tomorrow if that time today has already passed.
 *
 * The `en-CA` locale is a formatting trick, not a regional choice: it's the
 * one built-in Intl locale that renders as YYYY-MM-DD, which is exactly the
 * prefix `lib/time.ts`'s `toEpochMs` expects for a naive local datetime.
 */
function nextOccurrence(timeOfDay: string, timezone: string, fromMs: number): number {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(fromMs));

  const candidate = toEpochMs(`${dateStr}T${timeOfDay}`, timezone);
  return candidate > fromMs ? candidate : candidate + 24 * 60 * 60 * 1000;
}

/** Exported so `briefs.ensureScheduled` can compute a next occurrence too,
 *  without duplicating the Intl/toEpochMs logic above. */
export function nextOccurrenceOf(
  timeOfDay: string,
  timezone: string,
  fromMs = Date.now(),
): number {
  return nextOccurrence(timeOfDay, timezone, fromMs);
}

export const get = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    return (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;
  },
});

/**
 * Enable/disable/reschedule via chat. This mutation IS the whole reason the
 * schedule is user-editable with no redeploy — changing the time is just
 * calling this again with a new `timeOfDay`.
 *
 * Calling it with no arguments is a valid, deliberate no-op-ish call: it
 * returns the current config, reschedules at the same next occurrence, and
 * changes nothing else. That is what lets "what time is my brief?" be
 * answered by the same one tool instead of adding a third `brief.status`.
 */
export const configure = internalMutation({
  args: {
    userId: v.id("users"),
    timezone: v.string(),
    enabled: v.optional(v.boolean()),
    timeOfDay: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    const current = (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;

    const next: BriefConfig = {
      enabled: args.enabled ?? current.enabled,
      timeOfDay: args.timeOfDay ?? current.timeOfDay,
      notes: args.notes ?? current.notes,
    };

    // Cancel the job the OLD config owns before scheduling a new one — never
    // let two live jobs exist for the same config at once.
    if (current.scheduledJobId) {
      await ctx.scheduler.cancel(current.scheduledJobId);
    }

    let nextAt: number | undefined;
    if (next.enabled) {
      nextAt = nextOccurrence(next.timeOfDay, args.timezone, Date.now());
      next.scheduledJobId = await ctx.scheduler.runAt(nextAt, internal.briefs.deliver, {
        userId: args.userId,
      });
    } else {
      next.scheduledJobId = undefined;
    }

    if (row) {
      await ctx.db.patch("preferences", row._id, { value: next });
    } else {
      await ctx.db.insert("preferences", { userId: args.userId, key: KEY, value: next });
    }

    return { ...next, nextAt };
  },
});

/**
 * The self-perpetuating half of the chain. `briefs.deliver` calls this right
 * after sending, to schedule tomorrow's occurrence and store the new job id
 * — the same "compute, runAt, store" shape as `configure` above, just
 * without touching `enabled`/`timeOfDay`/`notes`.
 *
 * Also `ensureScheduled`'s target when it finds an enabled config with no
 * live `scheduledJobId` — the safety net for a broken chain.
 */
export const reschedule = internalMutation({
  args: { userId: v.id("users"), nextAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", KEY))
      .unique();
    const current = (row?.value as BriefConfig | undefined) ?? DEFAULT_CONFIG;

    // Turned off between the last delivery and this call — do not resurrect.
    if (!current.enabled) return;

    const jobId = await ctx.scheduler.runAt(args.nextAt, internal.briefs.deliver, {
      userId: args.userId,
    });
    const next: BriefConfig = { ...current, scheduledJobId: jobId };

    if (row) {
      await ctx.db.patch("preferences", row._id, { value: next });
    } else {
      await ctx.db.insert("preferences", { userId: args.userId, key: KEY, value: next });
    }
  },
});
```

**Verify:** `bun run typecheck` — clean. (`internal.briefs.deliver` doesn't exist until Step 6; typecheck will fail until then — that's expected and Step 6 closes it. If you want a clean typecheck before Step 6, comment out the two `ctx.scheduler.runAt(...)` calls temporarily, or just proceed — the plan reads correctly top to bottom and the whole feature typechecks together once Step 6 lands.)

---

## Step 2 — The tool contract

**File:** `convex/lib/tools/catalog.ts` **(edit)**

**What this does.** Adds `brief.configure` and `brief.preview` to `TOOL_SCHEMAS` and `TOOL_META`, following the exact pattern `account.connect_link` and `instruction.add` already use: a Zod object with a `.describe()` on every field (this is what makes natural language map onto the right argument instead of silently failing validation), plus a metadata entry saying it's not consequential.

Add this validator near the other reusable ones (`PRIORITY`, `INSTANT`, `EMAIL_LABEL`) — right after `EMAIL_LABEL`'s definition:

```ts
const TIME_OF_DAY = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM, e.g. 07:00")
  .describe('24-hour local time "HH:MM", e.g. "07:00"');
```

Add these two entries to `TOOL_SCHEMAS`, right after `"instruction.remove"`'s entry (i.e. as the last two before the closing `} as const;`):

```ts
  "brief.configure": z.object({
    enabled: z.boolean().optional().describe("turn the daily morning brief on or off"),
    timeOfDay: TIME_OF_DAY.optional(),
    notes: z
      .string()
      .optional()
      .describe("what the brief should focus on or skip, in your own words"),
  }),
  "brief.preview": z.object({}),
```

Add these two entries to `TOOL_META`, right after `"instruction.remove"`'s entry (i.e. as the last two before the closing `};`):

```ts
  "brief.configure": {
    description:
      "Turn the daily morning brief on or off, change what time it arrives, " +
      "or leave a note about what it should cover. Use whenever the user " +
      "asks to set up, change, or stop a recurring morning summary of " +
      'tasks, reminders, or important email. Calling this with no ' +
      'arguments returns the current setup unchanged — use it to answer ' +
      '"what time is my brief?" too, there is no separate status tool.',
    consequential: false,
    requiresAccountId: false,
  },
  "brief.preview": {
    description:
      "Compose today's morning brief right now and show it, without " +
      "touching the schedule. Use when the user wants to see it on demand " +
      "or test what it looks like before turning it on.",
    consequential: false,
    requiresAccountId: false,
  },
```

Nothing else in this file changes — `TOOL_NAMES`, `isToolName`, and `describeCatalog()` all derive from `TOOL_SCHEMAS`/`TOOL_META` automatically, so the model sees both new tools in its prompt the moment this file deploys.

**Verify:** `bun run typecheck` passes.

---

## Step 3 — Wire the tools

**File:** `convex/tools/router.ts` **(edit)**

**What this does.** Adds two `case`s to `dispatch()`'s switch. `brief.configure` calls straight through to the mutation from Step 1, using the `timezone` already available in `dispatch`'s destructured `{ userId, timezone }`. `brief.preview` calls `briefs.compose` as an action and returns its text — nothing here sends a second Telegram message; the returned text becomes the tool's `result`, and the normal reply pipeline (the same one every other tool result goes through) is what actually reaches the user.

Add these two `case`s inside the `switch (call.name)` block, after the existing `case "instruction.remove":` block and before the switch's closing brace:

```ts
    case "brief.configure": {
      const updated = await ctx.runMutation(internal.model.briefConfig.configure, {
        userId,
        timezone,
        enabled: a.enabled as boolean | undefined,
        timeOfDay: a.timeOfDay as string | undefined,
        notes: a.notes as string | undefined,
      });
      return {
        enabled: updated.enabled,
        timeOfDay: updated.timeOfDay,
        notes: updated.notes,
        nextAt:
          updated.nextAt === undefined ? undefined : formatInstant(updated.nextAt, timezone),
      };
    }

    case "brief.preview": {
      const text = await ctx.runAction(internal.briefs.compose, { userId });
      return { text };
    }
```

No new imports needed — `internal`, `formatInstant`, and `ActionCtx` are already imported at the top of this file from earlier phases.

**Verify:** `bun run typecheck` passes. Full wiring verification happens in Step 6's "Done when" — a router edit that only typechecks but was never actually invoked is exactly the failure mode `MEMORY.md` already flagged ("pure-renderer tests don't catch router wiring bugs"), which is why the real check is `bunx convex run debug:planOnly` against the live dev deployment, not just `tsc`.

---

## Step 4 — Render the confirmation

**File:** `convex/lib/tools/outcomes.ts` **(edit)**

**What this does.** Adds two `case`s to `renderOne()`. `brief.configure`'s confirmation states the resulting state plainly (on/off, at what time, when the next one lands) rather than echoing back exactly what changed — the *resulting* state is what matters to someone reading a chat message, not the diff. `brief.preview` just surfaces the composed text as-is; it needs no icon or preamble, since it *is* the content the user asked to see.

Add these two `case`s inside `renderOne()`'s switch, after the existing `case "instruction.remove":` block:

```ts
    case "brief.configure": {
      if (field(r, "enabled") !== true) return "🌅 Morning brief turned off.";
      const time = str(r, "timeOfDay") ?? "?";
      const next = str(r, "nextAt");
      const notes = str(r, "notes");
      return [
        `🌅 Morning brief on, daily at ${time}.`,
        next ? `Next one: ${next}.` : "",
        notes ? `Notes: ${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "brief.preview":
      return str(r, "text") ?? "(nothing to show)";
```

**Verify:** `bun run typecheck` passes.

---

## Step 5 — Write the failing test

**File:** `tests/unit/brief-compose.test.ts` **(create)**

**What this file is for.** Same move as Phase 1's Step 1: write the test against code that doesn't exist yet. It targets the two pure, `ctx`-free functions `briefs.ts` will export in Step 6 — `filterBriefEmails` (the CRITICAL/HIGH, non-promotional filter) and `renderBriefFacts` (structured facts → the plain-text block handed to the model). It deliberately does **not** test the `COMPOSE_BRIEF` model call itself — that's integration-verified manually, the same `bunx convex run debug:planOnly`-style check the project already relies on for anything that needs a live provider.

```ts
import { describe, expect, test } from "bun:test";
import {
  filterBriefEmails,
  renderBriefFacts,
  sinceYesterdayMidnight,
  type BriefEmail,
  type BriefFactsInput,
} from "../../convex/briefs";

const NOW = Date.parse("2026-08-22T09:00:00Z"); // a Saturday morning, WAT

const email = (over: Partial<BriefEmail> = {}): BriefEmail => ({
  from: "Sarah Chen <sarah@vercel.com>",
  subject: "Interview availability",
  importance: "HIGH",
  labelIds: ["INBOX"],
  inSpam: false,
  receivedAt: NOW - 60 * 60 * 1000, // an hour ago — inside the window by default
  alreadyAlerted: false,
  ...over,
});

const WINDOW = () => {
  const untilMs = NOW;
  const sinceMs = sinceYesterdayMidnight(untilMs, "Africa/Lagos");
  return { sinceMs, untilMs };
};

describe("sinceYesterdayMidnight", () => {
  test("a Saturday brief covers from Friday 00:00 WAT", () => {
    const sinceMs = sinceYesterdayMidnight(NOW, "Africa/Lagos");
    // Africa/Lagos is UTC+1: Friday 00:00 WAT = Thursday 23:00 UTC.
    expect(sinceMs).toBe(Date.parse("2026-08-21T23:00:00Z"));
  });
});

describe("filterBriefEmails", () => {
  test("keeps CRITICAL and HIGH inside the window", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL" }), email({ importance: "HIGH" })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(2);
  });

  test("drops NORMAL, LOW, and anything Phase 4 hasn't classified yet", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [
        email({ importance: "NORMAL" }),
        email({ importance: "LOW" }),
        email({ importance: undefined }),
      ],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops promotions and social even when marked HIGH", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [
        email({ importance: "HIGH", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
        email({ importance: "HIGH", labelIds: ["INBOX", "CATEGORY_SOCIAL"] }),
      ],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops anything from BEFORE yesterday midnight — the rolling window, not just 'recent'", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL", receivedAt: sinceMs - 60 * 60 * 1000 })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops an email already pushed as a real-time alert", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL", alreadyAlerted: true })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });
});

const baseFacts: BriefFactsInput = {
  timezone: "Africa/Lagos",
  sinceMs: sinceYesterdayMidnight(NOW, "Africa/Lagos"),
  tasks: [],
  blockers: [],
  reminders: [],
  projects: [],
  emails: [],
};

describe("renderBriefFacts", () => {
  test("marks every empty section (none) rather than omitting the label", () => {
    const out = renderBriefFacts(baseFacts);
    expect(out).toContain("OPEN TASKS\n  (none)");
    expect(out).toContain("BLOCKED\n  (none)");
    expect(out).toContain("IMPORTANT EMAIL");
  });

  test("formats a due task and a blocker with resolved local times", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      tasks: [
        {
          title: "Test the FedEx integration",
          status: "PLANNED",
          dueAt: Date.parse("2026-08-21T09:00:00Z"),
        },
      ],
      blockers: [
        {
          taskTitle: "Momentum Logistics server testing",
          description: "waiting on Paul's OTP",
          expectedAt: Date.parse("2026-08-21T09:00:00Z"),
        },
      ],
    });
    expect(out).toContain("Test the FedEx integration — PLANNED, due");
    expect(out).toContain(
      "Momentum Logistics server testing ← waiting on Paul's OTP, expected",
    );
  });

  test("excludes COMPLETED and CANCELLED tasks from OPEN TASKS", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      tasks: [
        { title: "Done thing", status: "COMPLETED" },
        { title: "Dead thing", status: "CANCELLED" },
        { title: "Live thing", status: "PLANNED" },
      ],
    });
    expect(out).not.toContain("Done thing");
    expect(out).not.toContain("Dead thing");
    expect(out).toContain("Live thing");
  });

  test("falls back to a judgement note when no owner notes are set", () => {
    expect(renderBriefFacts(baseFacts)).toContain("(none — use judgement)");
  });

  test("includes owner notes verbatim when given", () => {
    const out = renderBriefFacts({ ...baseFacts, notes: "Skip anything from recruiters." });
    expect(out).toContain("Skip anything from recruiters.");
  });

  test("flags a SPAM-folder email in the important-email section", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      emails: [
        {
          from: "Sarah Chen <sarah@vercel.com>",
          subject: "Interview availability",
          importance: "CRITICAL",
          labelIds: ["SPAM"],
          inSpam: true,
          receivedAt: NOW,
          alreadyAlerted: false,
        },
      ],
    });
    expect(out).toContain("[CRITICAL] Sarah Chen <sarah@vercel.com>");
    expect(out).toContain("found in SPAM");
  });

  test("states the actual window in the section header", () => {
    const out = renderBriefFacts(baseFacts);
    expect(out).toContain("IMPORTANT EMAIL SINCE");
  });
});
```

**Verify:** `bun test tests/unit/brief-compose.test.ts` — it fails to resolve the import. Expected — `convex/briefs.ts` doesn't exist yet.

---

## Step 6 — The feature itself

**File:** `convex/briefs.ts` **(create)**

**What this file is for.** Everything else. The top half is pure, `ctx`-free gathering/formatting logic — the part Step 5 tests, and where `sinceYesterdayMidnight` (the rolling-window boundary) and the already-alerted exclusion live. The bottom half is three `internalAction`s: `compose` (gather real data, ask the model to write the prose, return it — used both on-demand and by scheduled delivery), `deliver` (the scheduler's target — mirrors `convex/reminders.ts`'s `deliver` shape, with one addition: it reschedules itself), and `ensureScheduled` (the daily safety-net cron target — mirrors `reminders.ts`'s `reconcile`).

This file has one new dependency the earlier design didn't: **`convex/model/notifications.ts`, from Phase 5.** `gatherAndCompose` calls `notifications.findByThreadKey` to check whether a candidate email's thread already got a real-time alert. If Phase 5 isn't built yet when you reach this step, that import fails — build Phase 5 first, or stub the lookup to always return "not alerted" and revisit once it exists.

```ts
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { sendMessage } from "./channels/telegram";
import { formatInstant, toEpochMs } from "./lib/time";
import { nextOccurrenceOf } from "./model/briefConfig";

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

const COMPOSE_SYSTEM = `You write Adedotun's daily morning brief for Telegram.

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

async function gatherAndCompose(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";

  const [config, tasksRaw, blockersRaw, reminders, projects, accounts] = await Promise.all([
    ctx.runQuery(internal.model.briefConfig.get, { userId }),
    ctx.runQuery(internal.model.tasks.list, { userId, limit: 25 }),
    ctx.runQuery(internal.model.tasks.openBlockers, { userId }),
    ctx.runQuery(internal.model.reminders.listPending, { userId }),
    ctx.runQuery(internal.model.projects.listActive, { userId, limit: 15 }),
    ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId }),
  ]);

  const untilMs = Date.now();
  const sinceMs = sinceYesterdayMidnight(untilMs, timezone);

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
    tasks: tasksRaw.map((t) => ({ title: t.title, status: t.status, dueAt: t.dueAt })),
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

  const result = await runTask("COMPOSE_BRIEF", {
    system: COMPOSE_SYSTEM,
    input: renderBriefFacts(facts),
    maxOutputTokens: 700,
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
      result: "ok",
    });
  },
});
```

**Verify:**

- `bun test tests/unit/brief-compose.test.ts` — all tests from Step 5 pass.
- `bun run typecheck` — clean, and this is also what confirms Steps 1 and 3's forward references to `internal.briefs.deliver` and `internal.briefs.compose` resolve now.

---

## Step 7 — The safety-net cron

**File:** `convex/crons.ts` **(edit)**

**What this does.** One line. The identifier must be plain ASCII — space-separated lowercase words, no em dashes — because a non-ASCII cron identifier fails at *deploy* time, not typecheck; this has already broken a real deploy on this project once.

Add this line after the two `mailbox sync` crons, and update the stale forward-reference comment above it:

```ts
// Phase 3 — mailbox sync. UTC: Lagos is UTC+1, so 05-22 WAT is 04-21 UTC.
crons.cron("mailbox sync waking", "*/10 4-21 * * *", internal.gmail.syncAll, {});
crons.cron("mailbox sync overnight", "*/30 22,23,0-3 * * *", internal.gmail.syncAll, {});

// Phase 8 adds: daily Gmail watch renewal
// Phase 05B — morning brief safety net. The brief itself is self-scheduling
// (convex/briefs.ts's deliver() reschedules itself +24h after every send,
// same as a reminder's runAt chain never involves this file); this only
// fires if that chain broke. 08:00 WAT is 07:00 UTC — comfortably after the
// earliest sane brief time, so it never races a same-day first-time enable.
crons.cron("ensure brief scheduled", "0 7 * * *", internal.briefs.ensureScheduled, {});
// Phase 12 still adds: an evening brief (~19:00 WAT) — a second, separate
// self-scheduling chain, not touched by this doc.
```

**Verify:** the `convex dev` terminal pushes without error. If the identifier had a stray em dash or curly quote, this is where it would fail — not at `bun run typecheck`.

---

## Step 8 — The on-demand command

**File:** `convex/assistant.ts` **(edit)**

**What this does.** `/brief` composes and sends today's brief immediately, whether or not the daily schedule is even turned on — the same on-demand path `brief.preview` uses, just reached by a slash command instead of natural language.

Add this line to the `/help` list, after the `/reminders` line:

```ts
        "/reminders — what's scheduled",
        "/brief — compose today's morning brief now",
```

Add this `case` to `handleCommand`'s switch, after `case "/reminders":`:

```ts
    case "/reminders":
      return await remindersCommand(ctx, userId);
    case "/brief":
      return await briefCommand(ctx, userId);
```

Add this function, near the other command helpers (`tasksCommand`, `blockedCommand`, `remindersCommand`):

```ts
async function briefCommand(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  return await ctx.runAction(internal.briefs.compose, { userId });
}
```

No new imports — `internal`, `ActionCtx`, and `Id` are already imported at the top of this file.

**Verify:** `bun run typecheck` passes.

---

## Done when

- [ ] `bun test` — every test passes, including the new `brief-compose.test.ts` suite
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex deploy` — succeeds (the cron identifier from Step 7 is what would reject a bad deploy here)
- [ ] Telegram: *"send me a morning brief every day at 7, just tasks/reminders and non-promotional important email"* → the bot confirms it's on, with a time and a "next one" instant
- [ ] Convex dashboard → `preferences` table has one row with `key: "morning_brief"`, `value.scheduledJobId` set, and a `scheduledFunctions` entry for `internal.briefs.deliver` at the right instant
- [ ] Telegram: *"actually make it 8am"* → the bot confirms the new time, **and** the `preferences` row's `scheduledJobId` has changed (the old scheduled function is gone from `_scheduled_functions`, a new one exists) — this is the literal proof the reschedule worked, not just that the bot claimed it did
- [ ] Telegram: *"turn off my morning brief"* → confirmed off, and the `scheduledJobId` field clears
- [ ] `/brief` produces a real brief on demand, with the daily schedule left exactly as it was before
- [ ] `bunx convex run debug:planOnly '{"text":"give me a recap every morning at 7:30","execute":true}'` against dev — `outcomes` contains a successful `brief.configure` call and `rendered` reads like the confirmation a human would want, not raw JSON. This is the check that actually exercises `tools/router.ts`'s wiring, not just its typecheck.
- [ ] With Phase 4 not yet built (or no CRITICAL/HIGH mail currently classified): `/brief` still returns a sensible message with the email section simply absent — never an error, never a placeholder

```bash
git add -A && git commit -m "Phase 05B: chat-configurable morning brief, self-scheduling via runAt"
```

---

## What each file does, one line each

| File | Responsibility |
| --- | --- |
| `convex/model/briefConfig.ts` | The schedule's state, and the only code that calls `ctx.scheduler.runAt`/`cancel` for it |
| `convex/briefs.ts` | Gathers the facts, asks the model to write the prose, delivers it, reschedules itself |
| `convex/lib/tools/catalog.ts` | `brief.configure`/`brief.preview`'s argument contract |
| `convex/tools/router.ts` | Wires those two tools to `briefConfig` and `briefs.compose` |
| `convex/lib/tools/outcomes.ts` | Turns a `brief.configure`/`brief.preview` result into the sentence the user reads |
| `convex/crons.ts` | The one safety-net cron — not the delivery mechanism |
| `convex/assistant.ts` | `/brief`, the on-demand path |

---

## Next

**Phase 06 — Draft, approve, send (single mailbox).** The first outbound capability, and the highest-risk phase in the roadmap: a consequential tool that cannot be talked around, gated behind an approval whose hash is recomputed from the live draft at send time, never trusted from storage.
