# Phase 5 — Telegram alerts, summaries, full content on demand

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** `docs/Personal AI Assistant — Build Plan v3 (Convex).md` → *Phase 5*
- **Prerequisite:** Phase 4 complete — every newly-synced `emailMessages` row now carries `importance`, `classification`, `classifiedAt`, `classifierVersion`. This doc reads those fields; it does not re-derive them.

---

## What you'll have at the end

A `CRITICAL` or `HIGH` email produces a Telegram card — badged `⚠️ found in SPAM` when it's earned it, naming the mailbox, with four buttons — within one sync cycle. `[ TL;DR ]` gets you an AI summary. `[ Full message ]` gets you the whole body. `[ Not important ]` teaches the classifier and shuts that sender up. `[ Draft a reply ]` tells you plainly that Phase 6 hasn't landed yet, instead of doing nothing or pretending.

Three replies on one thread inside an hour update one card, not three. A burst past six alerts an hour collapses into a single digest notice instead of paging your phone forever. Every field that reaches Telegram is MarkdownV2-escaped, so nothing in an attacker-controlled subject line can break a card's layout or fake a button.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
| --- | --- | --- | --- |
| 1 | `package.json` | edit | Add `@convex-dev/rate-limiter` |
| 2 | `convex/convex.config.ts` | new | Mount the rate limiter component |
| 3 | `convex/model/notifications.ts` | new | Dedup lookup, record, edit-in-place for the `notifications` table |
| 4 | `convex/model/feedback.ts` | new | What `[ Not important ]` writes |
| 5 | `tests/unit/telegram-markdown.test.ts` | new | The failing test that defines MarkdownV2 escaping |
| 6 | `convex/lib/telegram/markdown.ts` | new | **Pure.** Escapes Telegram's MarkdownV2 special characters |
| 7 | `tests/unit/notify-card.test.ts` | new | The failing test that defines card composition |
| 8 | `convex/notify.ts` | new | `composeCard` (pure) + `sendAlert` (dedup → rate limit → send-or-edit) |
| 9 | `convex/channels/telegram.ts` | edit | Add `sendCard`, `editCard`, `answerCallbackQuery` |
| 10 | `convex/http.ts` | edit | Parse and route `callback_query` updates |
| 11 | `convex/assistant.ts` | edit | `handleCallback` — a button tap becomes an action |
| 12 | `convex/gmail.ts` | edit | Wire the delivery-rule branch into `syncAccount` |
| 13 | `convex/lib/tools/catalog.ts`, `convex/tools/router.ts`, `convex/lib/tools/outcomes.ts` | edit | Add the `email.summarize_thread` tool |

**New webhook surface, not a small addition.** Telegram delivers a button tap as `update.callback_query` — a different shape from `update.message`, with its own `id` to acknowledge, its own `from`/`message` nesting, and no `text` field at all. Steps 10–11 build a parser, an owner check, and a dispatcher for it from scratch, the same care Phase 1 gave `update.message`. Treat it as new surface, not as a branch bolted onto the text-message path.

---

## Step 1 — Add the rate limiter dependency

**File:** `package.json` **(edit)**

**What this does.** The alert cap (6/hour) needs a transactional counter that survives concurrent syncs across three mailboxes without racing. `@convex-dev/rate-limiter` gives you a token bucket with that guarantee built in — the whole implementation is one `rateLimiter.limit(ctx, "alerts", { key: userId, throws: false })` call, built in Step 8.

Add to `dependencies`:

```json
  "dependencies": {
    "@convex-dev/rate-limiter": "0.3.2",
    "convex": "1.44.0",
    "zod": "4.4.3"
  },
```

**Verify:** `bun install` — resolves cleanly.

---

## Step 2 — Mount the rate limiter component

**File:** `convex/convex.config.ts` **(create)**

**What this file is for.** Convex components (a rate limiter, an aggregate, an agent) are installable subsystems with their own isolated tables — mounting one here is what makes `components.rateLimiter` exist in the generated API. This project has no `convex.config.ts` yet, so this is the first one.

```ts
import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp();
app.use(rateLimiter);

export default app;
```

> No `.js` suffix on the import — that matches this Convex version's component-mounting convention. Getting this wrong fails at `convex dev` codegen time, not at typecheck time.

**Verify:** `bunx convex dev` — codegen succeeds and `convex/_generated/api.d.ts` now exports a `components` object with a `rateLimiter` key. (This is the one step in this phase that needs a live `convex dev` — every other step is `bun test` / `bun run typecheck`.)

---

## Step 3 — Notifications: dedup, record, edit-in-place

**File:** `convex/model/notifications.ts` **(create)**

**What this file is for.** The only reads and writes against the `notifications` table (already in `schema.ts` since Phase 0 — nothing to add there). `findByThreadKey` answers "is there already a live card for this thread?" so `sendAlert` (Step 8) can edit instead of posting a duplicate.

```ts
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Three replies on one thread inside this window update ONE card instead of
 * posting three. Freshness is checked by the CALLER (an action), never here —
 * a query must never read the wall clock, because a query is not re-run just
 * because time passes, so a time-derived result inside one would silently go
 * stale.
 */
export const DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** The most recent notification for a thread, or null. Staleness is the
 *  caller's job — see DEDUP_WINDOW_MS above. */
export const findByThreadKey = internalQuery({
  args: { threadKey: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_thread_key", (q) => q.eq("threadKey", args.threadKey))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

/** A brand-new card. `channelMessageId` is what `editCard` needs the next
 *  time this thread gets a reply. */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    channel: v.string(),
    emailMessageId: v.optional(v.id("emailMessages")),
    threadKey: v.optional(v.string()),
    channelMessageId: v.optional(v.string()),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const notificationId = await ctx.db.insert("notifications", {
      ...args,
      sentAt: Date.now(),
    });
    return { notificationId };
  },
});

/** The existing card got new content — bump `sentAt` too, so a further reply
 *  inside the window keeps editing the same message rather than reverting to
 *  "stale, post a new one" right after this one refreshed it. */
export const updateChannelMessageId = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    channelMessageId: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("notifications", args.notificationId, {
      channelMessageId: args.channelMessageId,
      payload: args.payload,
      sentAt: Date.now(),
    });
  },
});
```

**Verify:** `bun run typecheck` passes.

---

## Step 4 — Feedback: what `[ Not important ]` writes

**File:** `convex/model/feedback.ts` **(create)**

**What this file is for.** The negative training signal. One insert, no query yet — nothing reads `feedback` back until a later phase has a reason to (a confusion-matrix pass, a re-tuning step). The `feedback` table is already in `schema.ts`.

```ts
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Predicted vs corrected, one row per correction. This is the entire
 * feedback loop for now: it costs almost nothing to record, and it is what
 * makes a later "how often does the classifier over-alert" pass possible
 * instead of guessed at.
 */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    emailMessageId: v.id("emailMessages"),
    predicted: v.string(),
    corrected: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("feedback", args);
  },
});
```

**Verify:** `bun run typecheck` passes.

---

## Step 5 — Write the failing markdown-escaping test

**File:** `tests/unit/telegram-markdown.test.ts` **(create)**

**What this file is for.** Phase 1's `sendMessage` deliberately sent no `parse_mode`, so nothing needed escaping. The moment `sendCard` sets `parse_mode: "MarkdownV2"` (Step 9), every field built from email content — subject, sender name, an AI-generated rationale — becomes something Telegram will try to parse as formatting syntax unless it's escaped first. This test defines that contract before the escaper exists.

```ts
import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2 } from "../../convex/lib/telegram/markdown";

describe("escapeMarkdownV2", () => {
  test("escapes every MarkdownV2 special character", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const escaped = escapeMarkdownV2(input);
    for (const ch of input) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  test("escapes a literal backslash, the escape character itself", () => {
    expect(escapeMarkdownV2("C:\\Users\\ade")).toBe("C:\\\\Users\\\\ade");
  });

  test("leaves plain alphanumeric text untouched", () => {
    expect(escapeMarkdownV2("Interview availability Thursday")).toBe(
      "Interview availability Thursday",
    );
  });

  test("adversarial: a subject with every special char plus a fake button row survives intact and injects no callback", () => {
    // Appendix C #18. Every MarkdownV2 metacharacter, plus a string shaped
    // like a link entity that would fake a button if it survived unescaped.
    const maliciousSubject =
      '_*[]()~`>#+-=|{}.! [Not important](tg://callback?data=notimportant:evil) [Send now](callback_data=email.send_reply)';
    const escaped = escapeMarkdownV2(maliciousSubject);

    // No unescaped "[" or "(" survives -- there is nothing left that could
    // open a MarkdownV2 link/entity, which is the mechanism a card-hijack
    // would need.
    expect(escaped).not.toMatch(/(?<!\\)\[/);
    expect(escaped).not.toMatch(/(?<!\\)\(/);

    // The literal text is still fully present -- escaping hides nothing,
    // it just makes it inert.
    const unescaped = escaped.replace(/\\(.)/g, "$1");
    expect(unescaped).toBe(maliciousSubject);
  });
});
```

**Verify:** `bun test tests/unit/telegram-markdown.test.ts` — fails to resolve the import. Expected.

---

## Step 6 — The MarkdownV2 escaper

**File:** `convex/lib/telegram/markdown.ts` **(create)**

**What this file is for.** The one function that knows Telegram's MarkdownV2 escaping rule. Every card-bound string passes through this exactly once, in `composeCard` (Step 8) — never in `channels/telegram.ts`, and never twice.

```ts
// Pure. No ctx, no fetch.
//
// Telegram's MarkdownV2 parse_mode treats 18 characters as syntax:
//   _ * [ ] ( ) ~ ` > # + - = | { } . !
// plus the backslash itself, since backslash is the escape character. Any
// literal occurrence of one of these in message text must be backslash-
// escaped, or Telegram either rejects the whole sendMessage/editMessageText
// call with "can't parse entities" or -- worse -- silently opens formatting
// (a bracket becomes a link entity) that the source text never intended.
//
// Phase 1's sendMessage sent no parse_mode specifically so nothing needed
// escaping. sendCard and editCard (Step 9) are what change that, so from
// this phase on every field built from email content -- subject, sender
// name, an AI-generated rationale -- MUST run through this first.

const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, (ch) => `\\${ch}`);
}
```

**Verify:** `bun test tests/unit/telegram-markdown.test.ts` — all 4 tests pass. No Convex running, no network.

---

## Step 7 — Write the failing card-composition test

**File:** `tests/unit/notify-card.test.ts` **(create)**

**What this file is for.** Golden-output tests for the card layout from the source plan's mock, plus the guarantee that `composeCard` escapes untrusted fields before they ever reach `channels/telegram.ts`.

```ts
import { describe, expect, test } from "bun:test";
import { composeCard, CALLBACK_PREFIX, type CardEmail } from "../../convex/notify";

const base: CardEmail = {
  emailMessageId: "msg42",
  accountLabel: "recruiting",
  fromAddress: "s.chen@vercel.com",
  fromName: "Sarah Chen",
  subject: "Interview availability — Senior Frontend Engineer",
  isSpam: true,
  importance: "CRITICAL",
  whyItMatters:
    "Recruiter following up on your application; asks for availability this week. You have not replied.",
  deadlineMentioned: "2026-08-21T09:00:00.000Z",
};

describe("composeCard", () => {
  test("renders the CRITICAL + SPAM badge card from the source mock", () => {
    const card = composeCard(base, "Africa/Lagos");
    expect(card.text).toContain("🔴 CRITICAL");
    expect(card.text).toContain("recruiting");
    expect(card.text).toContain("⚠️ found in SPAM");
    expect(card.text).toContain("Sarah Chen");
    expect(card.text).toContain("Why it matters:");
    expect(card.text).toContain("Deadline mentioned:");
  });

  test("omits the SPAM badge when the message is not in spam", () => {
    const card = composeCard({ ...base, isSpam: false }, "Africa/Lagos");
    expect(card.text).not.toContain("SPAM");
  });

  test("escapes MarkdownV2 special characters in the subject and sender", () => {
    const card = composeCard(
      { ...base, subject: "Re: [URGENT] *now*!", fromName: "A. Chen (Talent)" },
      "Africa/Lagos",
    );
    expect(card.text).toContain("\\[URGENT\\]");
    expect(card.text).toContain("\\*now\\*\\!");
    expect(card.text).toContain("\\(Talent\\)");
  });

  test("formats the deadline in the given timezone using the shared formatter", () => {
    const card = composeCard(base, "Africa/Lagos");
    // 2026-08-21T09:00:00.000Z is 10:00 in Africa/Lagos (UTC+1).
    expect(card.text).toContain("10:00");
  });

  test("omits the why-it-matters and deadline sections when absent", () => {
    const card = composeCard(
      { ...base, whyItMatters: undefined, deadlineMentioned: undefined },
      "Africa/Lagos",
    );
    expect(card.text).not.toContain("Why it matters:");
    expect(card.text).not.toContain("Deadline mentioned:");
  });

  test("wires all four buttons to the right emailMessageId, using CALLBACK_PREFIX", () => {
    const card = composeCard(base, "Africa/Lagos");
    const data = card.buttons.flat().map((b) => b.data);
    expect(data).toEqual([
      `${CALLBACK_PREFIX.TLDR}:msg42`,
      `${CALLBACK_PREFIX.FULL}:msg42`,
      `${CALLBACK_PREFIX.DRAFT}:msg42`,
      `${CALLBACK_PREFIX.NOT_IMPORTANT}:msg42`,
    ]);
  });
});
```

**Verify:** `bun test tests/unit/notify-card.test.ts` — fails to resolve the import. Expected.

---

## Step 8 — `composeCard` + `sendAlert`

**File:** `convex/notify.ts` **(create)**

**What this file is for.** `composeCard` is pure — it builds the card's text and button layout from plain data, with no `ctx` and no network, which is what makes Step 7's tests possible with no Convex runtime. `sendAlert` is the action wrapping it: dedup check → rate-limit check → send-or-edit → record.

**Two rows of two, not one row of four.** The source mock draws `[ TL;DR ] [ Full message ] [ Draft a reply ] [ Not important ]` as a single line — that reads fine as prose but renders as four cramped buttons on a phone screen. Same four actions, laid out for actual thumbs.

```ts
import { internalAction } from "./_generated/server";
import { internal, components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { sendCard, editCard, sendMessage, type InlineButton } from "./channels/telegram";
import { escapeMarkdownV2 } from "./lib/telegram/markdown";
import { formatInstant } from "./lib/time";
import { DEDUP_WINDOW_MS } from "./model/notifications";

/**
 * 6/hour, replenishing continuously (a token bucket, not a fixed window) so
 * "6 at 12:00 then 6 more at 12:01" cannot happen. Capacity equals the rate,
 * so there is no accumulated burst beyond the steady-state cap.
 */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  alerts: { kind: "token bucket", rate: 6, period: HOUR, capacity: 6 },
  // A second, much stricter bucket for the "you hit the limit" notice
  // itself -- one notice per breach, not one per suppressed email. This is
  // the entire "collapse into a digest" behaviour this phase implements; a
  // fuller per-email digest card is Phase 05B's job, once the morning brief
  // exists to fold suppressed alerts into.
  alertDigest: { kind: "token bucket", rate: 1, period: HOUR, capacity: 1 },
});

/** Short, stable prefixes so callback_data stays well under Telegram's
 *  64-byte cap even with a full Convex id appended, and so notify.ts and
 *  assistant.ts can never drift on the string each expects. */
export const CALLBACK_PREFIX = {
  TLDR: "tldr",
  FULL: "full",
  DRAFT: "draft",
  NOT_IMPORTANT: "notimportant",
} as const;

export interface CardEmail {
  emailMessageId: string;
  accountLabel: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  isSpam: boolean;
  importance: "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "IGNORE";
  whyItMatters?: string;
  /** ISO 8601, Phase 4's ImportanceSchema.deadlineMentioned shape -- or
   *  undefined/null when the classifier found no deadline. */
  deadlineMentioned?: string | null;
}

export interface ComposedCard {
  text: string;
  buttons: InlineButton[][];
}

const IMPORTANCE_ICON: Record<CardEmail["importance"], string> = {
  CRITICAL: "🔴",
  HIGH: "🟠",
  NORMAL: "🟡",
  LOW: "⚪",
  IGNORE: "⚪",
};

/**
 * Pure. Every field here is load-bearing (source plan, Phase 5): the SPAM
 * badge is the visible proof the spam requirement works, the mailbox label
 * is what makes a three-mailbox setup legible, and the deadline line is what
 * a glance at Telegram needs to answer "does this need me today".
 *
 * Every untrusted or semi-trusted string -- subject, sender name, the
 * classifier's free-text rationale -- is escaped via escapeMarkdownV2
 * exactly once, here. channels/telegram.ts never escapes anything; this is
 * the only place that can get it wrong, which is the point.
 */
export function composeCard(email: CardEmail, timezone: string): ComposedCard {
  const icon = IMPORTANCE_ICON[email.importance];
  const from = email.fromName
    ? `${escapeMarkdownV2(email.fromName)} <${escapeMarkdownV2(email.fromAddress)}>`
    : escapeMarkdownV2(email.fromAddress);

  const header = [`${icon} ${email.importance} · ${escapeMarkdownV2(email.accountLabel)}`];
  if (email.isSpam) header.push("⚠️ found in SPAM");

  const lines = [
    header.join("  ·  "),
    "",
    `From:     ${from}`,
    `Subject:  ${escapeMarkdownV2(email.subject ?? "(no subject)")}`,
  ];

  if (email.whyItMatters) {
    lines.push("", "Why it matters:", escapeMarkdownV2(email.whyItMatters));
  }

  if (email.deadlineMentioned) {
    const ms = Date.parse(email.deadlineMentioned);
    const formatted = Number.isNaN(ms)
      ? escapeMarkdownV2(email.deadlineMentioned)
      : escapeMarkdownV2(formatInstant(ms, timezone));
    lines.push("", `Deadline mentioned: ${formatted}`);
  }

  const id = email.emailMessageId;
  return {
    text: lines.join("\n"),
    buttons: [
      [
        { text: "TL;DR", data: `${CALLBACK_PREFIX.TLDR}:${id}` },
        { text: "Full message", data: `${CALLBACK_PREFIX.FULL}:${id}` },
      ],
      [
        { text: "Draft a reply", data: `${CALLBACK_PREFIX.DRAFT}:${id}` },
        { text: "Not important", data: `${CALLBACK_PREFIX.NOT_IMPORTANT}:${id}` },
      ],
    ],
  };
}

export const sendAlert = internalAction({
  args: {
    userId: v.id("users"),
    chatId: v.string(),
    timezone: v.string(),
    emailMessageId: v.id("emailMessages"),
    threadKey: v.string(),
    accountLabel: v.string(),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    subject: v.optional(v.string()),
    isSpam: v.boolean(),
    importance: v.string(),
    whyItMatters: v.optional(v.string()),
    deadlineMentioned: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const card = composeCard(
      {
        emailMessageId: args.emailMessageId,
        accountLabel: args.accountLabel,
        fromAddress: args.fromAddress,
        fromName: args.fromName,
        subject: args.subject,
        isSpam: args.isSpam,
        importance: args.importance as CardEmail["importance"],
        whyItMatters: args.whyItMatters,
        deadlineMentioned: args.deadlineMentioned,
      },
      args.timezone,
    );

    // Dedup FIRST. Editing an existing card is not a new alert, so it must
    // never touch the rate limiter -- three replies on one thread inside the
    // window cost one token, not three.
    const existing = await ctx.runQuery(internal.model.notifications.findByThreadKey, {
      threadKey: args.threadKey,
    });
    const fresh = existing !== null && Date.now() - existing.sentAt <= DEDUP_WINDOW_MS;

    if (fresh && existing?.channelMessageId) {
      await editCard(args.chatId, existing.channelMessageId, card.text, card.buttons);
      await ctx.runMutation(internal.model.notifications.updateChannelMessageId, {
        notificationId: existing._id,
        channelMessageId: existing.channelMessageId,
        payload: card,
      });
      return;
    }

    // A genuinely new thread -- this is what the token bucket caps.
    const check = await rateLimiter.limit(ctx, "alerts", { key: args.userId, throws: false });
    if (!check.ok) {
      const digest = await rateLimiter.limit(ctx, "alertDigest", {
        key: args.userId,
        throws: false,
      });
      if (digest.ok) {
        await sendMessage(
          args.chatId,
          "⏳ Alert limit reached (6/hour). More important mail is arriving -- " +
            "nothing is lost, it just won't page you again until the limit resets.",
        );
      }
      return;
    }

    const channelMessageId = await sendCard(args.chatId, card.text, card.buttons);
    await ctx.runMutation(internal.model.notifications.record, {
      userId: args.userId,
      channel: "telegram",
      emailMessageId: args.emailMessageId,
      threadKey: args.threadKey,
      channelMessageId,
      payload: card,
    });
  },
});
```

**Verify:** `bun test tests/unit/notify-card.test.ts` — all 6 tests pass.

---

## Step 9 — `sendCard`, `editCard`, `answerCallbackQuery`

**File:** `convex/channels/telegram.ts` **(edit)**

**What this does.** Everything that knows Telegram's wire format still lives only here. `sendMessage` (Phase 1) stays plain-text for chat replies. `sendCard`/`editCard` are the formatted, buttoned path — parse_mode and inline keyboards, used only for notification cards. `answerCallbackQuery` clears the loading spinner Telegram puts on a tapped button.

First, update the file's top docblock — the "Phase 5 introduces formatted cards" sentence is no longer forward-looking:

```diff
- * Phase 1 deliberately does NOT set parse_mode: without it Telegram treats the
- * body as literal text, so there is nothing to escape and no way for message
- * content to break the layout. Phase 5 introduces formatted cards and, with
- * them, escaping.
+ * Phase 1 deliberately does NOT set parse_mode on sendMessage: without it
+ * Telegram treats the body as literal text, so a chat reply can never break
+ * on stray Markdown. sendCard/editCard below DO set parse_mode, which is
+ * why every field that reaches them must already be escaped by
+ * lib/telegram/markdown.ts (composeCard in convex/notify.ts is the only
+ * caller that does this) -- nothing in this file escapes anything itself.
```

Then add these three exports after `downloadFile` (and before the private `toBase64` helper at the bottom of the file):

```ts
export interface InlineButton {
  text: string;
  /** Becomes callback_data. Telegram caps this at 64 bytes total, including
   *  the prefix -- see CALLBACK_PREFIX in convex/notify.ts. */
  data: string;
}

function toInlineKeyboard(buttons: InlineButton[][]) {
  return buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data })));
}

/**
 * Send a MarkdownV2 card with an inline keyboard. Returns the new message's
 * id, the same way sendMessage does -- notify.ts stores it so a later reply
 * on the same thread can editCard instead of posting a duplicate.
 */
export async function sendCard(
  chatId: string,
  text: string,
  buttons: InlineButton[][],
): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: toInlineKeyboard(buttons) },
    }),
  });

  if (!res.ok) throw new Error(`telegram sendMessage(card) ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { result?: { message_id?: number } };
  return String(json.result?.message_id ?? "");
}

/** Edit an existing card in place. This is what makes three replies on one
 *  thread inside an hour update one message instead of posting three. */
export async function editCard(
  chatId: string,
  messageId: string,
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;

  const res = await fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      text: body,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: toInlineKeyboard(buttons) },
    }),
  });

  if (!res.ok) throw new Error(`telegram editMessageText ${res.status}: ${await res.text()}`);
}

/**
 * Clears the loading spinner Telegram shows on a tapped inline-keyboard
 * button. Telegram gives a callback_query roughly 10 seconds before the
 * client shows it as failed, so http.ts calls this BEFORE scheduling any
 * real work -- the same "acknowledge now, work later" shape as the message
 * webhook, just with a different acknowledgement call.
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const res = await fetch(`${API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });

  if (!res.ok) {
    throw new Error(`telegram answerCallbackQuery ${res.status}: ${await res.text()}`);
  }
}
```

**Verify:** `bun run typecheck` passes.

---

## Step 10 — Parse and route `callback_query`

**File:** `convex/http.ts` **(edit)**

**What this does.** Telegram sends a button tap as `update.callback_query`, never `update.message` — a fundamentally different update shape, so this needs its own parser, not a branch inside `parseTextMessage`. The same three rules from Phase 1 apply: verify the request is really Telegram (already done, once, before this branch), serve only the owner, acknowledge fast.

Add the import:

```ts
import { answerCallbackQuery } from "./channels/telegram";
```

Insert this block immediately after the JSON parse (`let update: unknown; try { ... } catch { ... }`) and **before** `const message = parseTextMessage(update);`:

```ts
    // A button tap on a card sendCard/editCard produced. Checked before
    // parseTextMessage because callback_query and message are mutually
    // exclusive on a Telegram Update -- there is no ambiguity to resolve.
    const callback = parseCallbackQuery(update);
    if (callback) {
      // Acknowledge FIRST. Telegram shows a spinner on the tapped button
      // until this responds, and times it out client-side around 10s --
      // well before a model call inside handleCallback could finish.
      await answerCallbackQuery(callback.id);

      if (callback.fromId !== process.env.TELEGRAM_OWNER_ID) {
        await ctx.runMutation(internal.model.audit.record, {
          actor: "system",
          action: "telegram.reject_unknown_sender",
          args: { fromId: callback.fromId },
          result: "denied",
        });
        return new Response(null, { status: 200 });
      }

      await ctx.scheduler.runAfter(0, internal.assistant.handleCallback, {
        telegramId: callback.fromId,
        chatId: callback.chatId,
        channelMessageId: callback.messageId,
        data: callback.data,
      });
      return new Response(null, { status: 200 });
    }

```

Then add this parser alongside `parseTextMessage`/`parseVoiceMessage`/`parseUnsupportedMessage` (after `parseVoiceMessage`, before the OAuth routes):

```ts
interface ParsedCallbackQuery {
  id: string;
  fromId: string;
  chatId: string;
  messageId: string;
  data: string;
}

/**
 * A tap on one of sendCard's inline-keyboard buttons. `callback_query.id` is
 * what answerCallbackQuery needs; `message.message_id` is the CARD's id
 * (what editCard would target), not a new inbound message id.
 */
function parseCallbackQuery(update: unknown): ParsedCallbackQuery | null {
  if (typeof update !== "object" || update === null) return null;
  const cq = (update as { callback_query?: unknown }).callback_query;
  if (typeof cq !== "object" || cq === null) return null;

  const c = cq as Record<string, unknown>;
  const from = c.from as { id?: unknown } | null;
  const message = c.message as { chat?: unknown; message_id?: unknown } | null;
  const chat = (message?.chat ?? null) as { id?: unknown } | null;

  if (typeof c.id !== "string") return null;
  if (typeof from?.id !== "number") return null;
  if (typeof chat?.id !== "number") return null;
  if (typeof message?.message_id !== "number") return null;
  if (typeof c.data !== "string") return null;

  return {
    id: c.id,
    fromId: String(from.id),
    chatId: String(chat.id),
    messageId: String(message.message_id),
    data: c.data,
  };
}
```

**Verify:** `bun run typecheck` passes. `bunx convex dev` pushes without error.

---

## Step 11 — `handleCallback`

**File:** `convex/assistant.ts` **(edit)**

**What this does.** Dispatches a button tap on its `CALLBACK_PREFIX`, the same shape as `handleCommand` dispatching on the first word of a slash command. `tldr`/`full` reuse `emailMessages.getById` the same way `email.get_message` does. `notimportant` writes the feedback row and adds the sender to `noiseSenders` (Phase 4). `draft` states plainly that Phase 6 hasn't landed — silence or a fake success would be worse.

Add the import:

```ts
import { CALLBACK_PREFIX } from "./notify";
```

Insert this block after `handleUnsupported`'s closing `});` and before the `TRANSCRIBE_SYSTEM` constant:

```ts
/**
 * A tap on a notification card's button. Unlike handleMessage, there is no
 * "in" message to persist here -- a callback_query is metadata about an
 * earlier card, not a new conversational turn -- so this goes straight from
 * dispatch to a reply.
 */
export const handleCallback = internalAction({
  args: {
    telegramId: v.string(),
    chatId: v.string(),
    channelMessageId: v.string(),
    data: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await ctx.runMutation(internal.model.users.ensureByTelegramId, {
      telegramId: args.telegramId,
      displayName: "owner",
    });

    const separator = args.data.indexOf(":");
    const prefix = separator === -1 ? args.data : args.data.slice(0, separator);
    const emailMessageId = separator === -1 ? "" : args.data.slice(separator + 1);

    try {
      switch (prefix) {
        case CALLBACK_PREFIX.TLDR:
          await replyWithSummary(ctx, args.chatId, emailMessageId);
          return;
        case CALLBACK_PREFIX.FULL:
          await replyWithFullMessage(ctx, args.chatId, emailMessageId);
          return;
        case CALLBACK_PREFIX.DRAFT:
          await sendMessage(
            args.chatId,
            "Drafting replies isn't built yet -- Phase 6 adds it. This button is here " +
              "so the card is complete; it does nothing until then.",
          );
          return;
        case CALLBACK_PREFIX.NOT_IMPORTANT:
          await markNotImportant(ctx, userId, args.chatId, emailMessageId);
          return;
        default:
          await sendMessage(args.chatId, `Unrecognized button: ${args.data}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.model.audit.record, {
        actor: "system",
        action: "assistant.handle_callback",
        args: { data: args.data },
        result: "error",
        errorMessage: detail.slice(0, 500),
      });
      await sendMessage(args.chatId, userFacingError(error, detail));
    }
  },
});

async function replyWithSummary(
  ctx: ActionCtx,
  chatId: string,
  emailMessageId: string,
): Promise<void> {
  const message = await ctx.runQuery(internal.model.emailMessages.getById, {
    emailMessageId: emailMessageId as Id<"emailMessages">,
  });
  if (!message) {
    await sendMessage(chatId, "That email is no longer available.");
    return;
  }

  const body = message.bodyText ?? message.snippet ?? "";
  const summary = await runTask("SUMMARIZE_THREAD", {
    system:
      "Summarize this email in two or three sentences a busy person can act on. " +
      "Plain text, no markdown, no preamble.",
    input: `Subject: ${message.subject ?? "(no subject)"}\nFrom: ${
      message.fromName ?? message.fromAddress
    }`,
    untrusted: [{ label: "email_body", content: body }],
    maxOutputTokens: 300,
  });

  await sendMessage(chatId, summary.text.trim());
}

async function replyWithFullMessage(
  ctx: ActionCtx,
  chatId: string,
  emailMessageId: string,
): Promise<void> {
  const message = await ctx.runQuery(internal.model.emailMessages.getById, {
    emailMessageId: emailMessageId as Id<"emailMessages">,
  });
  if (!message) {
    await sendMessage(chatId, "That email is no longer available.");
    return;
  }

  const from = message.fromName
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress;
  const body = message.bodyText ?? message.snippet ?? "(no body)";

  await sendMessage(
    chatId,
    `From: ${from}\nSubject: ${message.subject ?? "(no subject)"}\n\n${body}`,
  );
}

async function markNotImportant(
  ctx: ActionCtx,
  userId: Id<"users">,
  chatId: string,
  emailMessageId: string,
): Promise<void> {
  const message = await ctx.runQuery(internal.model.emailMessages.getById, {
    emailMessageId: emailMessageId as Id<"emailMessages">,
  });
  if (!message) {
    await sendMessage(chatId, "That email is no longer available.");
    return;
  }

  await ctx.runMutation(internal.model.feedback.record, {
    userId,
    emailMessageId: message._id,
    predicted: message.importance ?? "UNKNOWN",
    corrected: "LOW",
  });
  await ctx.runMutation(internal.model.noiseSenders.add, {
    userId,
    pattern: message.fromAddress,
  });

  await sendMessage(chatId, `Got it -- I won't flag ${message.fromAddress} as important again.`);
}
```

> `internal.model.noiseSenders.add` and `internal.model.emailMessages.getById`'s `importance` field both come from Phase 4 — this step calls them, it does not define them.

**Verify:** `bun run typecheck` passes.

---

## Step 12 — Wire delivery rules into `syncAccount`

**File:** `convex/gmail.ts` **(edit)**

**What this does.** `CRITICAL` notifies immediately. `HIGH` notifies immediately only during 07:00–22:00 WAT; outside that window it queues for the next morning brief (Phase 05B) instead of buzzing the phone at 3am. `NORMAL`/`LOW`/`IGNORE` never produce a direct alert here at all — `NORMAL` surfaces in the morning brief, `LOW`/`IGNORE` never do.

> This step assumes `PHASE-04-importance-classification.md` already landed. By this point in `syncAccount`'s per-message loop, Phase 4 has classified every newly-created message and ended its own block with a call to `internal.model.emailMessages.recordClassification`, leaving a local object in scope — call it `classified` — shaped like Phase 4's `ImportanceSchema` result (`importance`, `whyItMatters`, `deadlineMentioned`, and more that this phase doesn't need). This step reads only what it needs from that object; it does not redefine Phase 4's classification step.

Add the import:

```ts
import type { Id } from "./_generated/dataModel";
```

(`Id` may already be imported — `completeConnect`'s signature uses it. If so, skip this line.)

Inside the `for (const ref of listed.messages ?? [])` loop, immediately after the line where Phase 4's block calls `recordClassification`, insert:

```ts
        if (result.created) {
          await deliverIfDue(ctx, account, result.emailMessageId, normalized, classified);
        }
```

Then add these two new functions near the bottom of the file, after `notifyNeedsReauth`:

```ts
/** The subset of Phase 4's ImportanceSchema this phase actually reads. */
interface ClassificationResult {
  importance: string;
  whyItMatters?: string;
  deadlineMentioned?: string | null;
}

/** 07:00-22:00 WAT is the HIGH-importance immediate-notify window. Outside
 *  it, HIGH mail queues for the morning brief (Phase 05B) instead of paging
 *  the phone overnight. CRITICAL bypasses this entirely -- it always pages. */
function withinImmediateWindow(nowMs: number, timezone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(nowMs)),
  );
  return hour >= 7 && hour < 22;
}

async function deliverIfDue(
  ctx: ActionCtx,
  account: { userId: Id<"users">; label: string },
  emailMessageId: Id<"emailMessages">,
  normalized: ReturnType<typeof normalizeMessage>,
  classified: ClassificationResult,
): Promise<void> {
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
  const immediate =
    classified.importance === "CRITICAL" ||
    (classified.importance === "HIGH" && withinImmediateWindow(Date.now(), timezone));

  if (!immediate) return;

  const user = await ctx.runQuery(internal.model.users.get, { userId: account.userId });
  if (!user) return;

  await ctx.runAction(internal.notify.sendAlert, {
    userId: account.userId,
    // A private Telegram chat's id equals the user's own id -- the same
    // fact notifyNeedsReauth above already relies on.
    chatId: user.telegramId,
    timezone,
    emailMessageId,
    threadKey: normalized.threadId,
    accountLabel: account.label,
    fromAddress: normalized.fromAddress,
    fromName: normalized.fromName,
    subject: normalized.subject,
    isSpam: normalized.labelIds.includes("SPAM"),
    importance: classified.importance,
    whyItMatters: classified.whyItMatters,
    deadlineMentioned: classified.deadlineMentioned ?? undefined,
  });
}
```

**Verify:** `bun run typecheck` passes.

---

## Step 13 — Add the `email.summarize_thread` tool

**Files:** `convex/lib/tools/catalog.ts`, `convex/tools/router.ts`, `convex/lib/tools/outcomes.ts` **(edit)**

**What this does.** The `[ TL;DR ]` button (Step 11) runs a one-off summary outside the tool system entirely. This step is the *conversational* path — "summarize that email from Sarah" in chat — following the exact three-file pattern every tool in this codebase uses. `SUMMARIZE_THREAD` is already registered in `convex/lib/ai/tiers.ts` (Phase 5's comment is already there) — nothing to add there.

**`convex/lib/tools/catalog.ts`** — add to `TOOL_SCHEMAS`, alongside the other `email.*` entries:

```ts
  "email.summarize_thread": z.object({
    emailMessageId: z.string().min(1).describe("id from an email.list_recent or email.search result"),
  }),
```

And to `TOOL_META`:

```ts
  "email.summarize_thread": {
    description:
      "A short AI summary of one email -- what it's about and what, if anything, it asks of " +
      "you. Read-only.",
    consequential: false,
    requiresAccountId: true,
  },
```

**`convex/tools/router.ts`** — add the import:

```ts
import { runTask } from "../ai/registry";
```

And this `case` in `dispatch`'s `switch`, alongside `email.get_message`:

```ts
    case "email.summarize_thread": {
      const message = await ctx.runQuery(internal.model.emailMessages.getById, {
        emailMessageId: a.emailMessageId as Id<"emailMessages">,
      });
      if (!message) return { found: false };

      const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
        accountId: message.accountId,
      });
      if (!account || account.userId !== userId) return { found: false };

      const body = message.bodyText ?? message.snippet ?? "";
      const summary = await runTask("SUMMARIZE_THREAD", {
        system:
          "Summarize this email in two or three sentences a busy person can act on. " +
          "Plain text, no markdown, no preamble.",
        input: `Subject: ${message.subject ?? "(no subject)"}\nFrom: ${
          message.fromName ?? message.fromAddress
        }`,
        untrusted: [{ label: "email_body", content: body }],
        maxOutputTokens: 300,
      });

      return { found: true, summary: summary.text.trim() };
    }
```

**`convex/lib/tools/outcomes.ts`** — add this `case` in `renderOne`'s `switch`, alongside `email.get_message`:

```ts
    case "email.summarize_thread":
      if (field(r, "found") !== true) return "No email matching that id.";
      return `📝 ${str(r, "summary") ?? "(no summary)"}`;
```

**Verify:** `bun run typecheck` passes. Then, against the real dev deployment (the lesson from `MEMORY.md`: pure-renderer tests don't catch router-wiring bugs):

```bash
bunx convex run debug:planOnly '{"execute":true,"text":"summarize that email from Sarah"}'
```

confirms the model actually proposes `email.summarize_thread` with a real `emailMessageId`, not a hallucinated one.

---

## Done when

- [ ] `bun test` — 135 passing (125 from before this phase + 4 markdown-escaping + 6 card-composition)
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex dev` — pushes without error; `components.rateLimiter` exists in the generated API
- [ ] Send yourself a plausible recruiter email and mark it spam. Within one sync cycle: a Telegram card arrives, badged `⚠️ found in SPAM`, naming the correct mailbox
- [ ] `[ TL;DR ]` returns a short AI summary
- [ ] `[ Full message ]` returns the full body
- [ ] `[ Not important ]` sends a confirmation, and a `feedback` row plus a `noiseSenders` row exist in the Convex dashboard
- [ ] `[ Draft a reply ]` replies stating Phase 6 isn't built yet — no crash, no fake success
- [ ] Reply on the same thread a second time inside an hour — the SAME Telegram message updates in place, no second card appears; the `notifications` row's `channelMessageId` is unchanged and `sentAt` advanced
- [ ] Trigger seven CRITICAL/HIGH alerts for one user inside an hour (test data is fine) — the first six post normally, the seventh produces exactly one "Alert limit reached" notice, not a seventh card
- [ ] In chat: "summarize that email from Sarah" — the model calls `email.summarize_thread`, verified via `debug:planOnly` against dev

```bash
git add -A && git commit -m "Phase 5: Telegram alert cards, callback_query webhook, rate-limited delivery"
```

---

## What each file does, one line each

| File | Responsibility |
| --- | --- |
| `convex/notify.ts` | Composes cards, dedups by thread, rate-limits, sends or edits. |
| `convex/lib/telegram/markdown.ts` | The one place that escapes MarkdownV2. |
| `convex/channels/telegram.ts` | Speaks Telegram's wire format — plain text, cards, and callback acks. |
| `convex/http.ts` | Front door for both `update.message` and `update.callback_query`. |
| `convex/assistant.ts` | Decides what a message OR a button tap means. |
| `convex/gmail.ts` | Sync loop — now branches on the delivery rule after classifying. |
| `convex/model/notifications.ts` | `notifications` table reads and writes; the dedup lookup. |
| `convex/model/feedback.ts` | `feedback` table writes — the `[ Not important ]` signal. |
| `convex/convex.config.ts` | Mounts the rate limiter component. |
| `convex/lib/tools/catalog.ts` | Adds `email.summarize_thread` to the tool contract. |
| `convex/tools/router.ts` | Executes `email.summarize_thread`. |
| `convex/lib/tools/outcomes.ts` | Renders its result as a sentence. |

---

## Next

**Phase 05B — Morning brief.** A daily message — open tasks, pending reminders, `NORMAL`-importance and after-hours-`HIGH` email — sent at a time you set by talking to the bot, using the same `ctx.scheduler.runAt` self-scheduling pattern `convex/model/reminders.ts` already established, not a fixed cron. This is also where the rate-limited alerts this phase suppresses (the "queued" half of the `HIGH` delivery rule, and every `NORMAL` message) actually surface.
