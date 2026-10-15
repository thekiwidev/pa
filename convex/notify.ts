import { internalAction } from "./_generated/server";
import { internal, components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { sendCard, editCard, sendMessage, type InlineButton } from "./channels/telegram";
import { escapeTelegramHtml, alreadyHtml } from "./lib/telegram/html";
import type { TelegramHtml } from "./lib/telegram/html";
import { formatInstant } from "./lib/time";
import { DEDUP_WINDOW_MS } from "./model/notifications";
import { IMPORTANCE_ICON } from "./lib/email/classification";

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
  text: TelegramHtml;
  buttons: InlineButton[][];
}



/**
 * Pure. Every field here is load-bearing (source plan, Phase 5): the SPAM
 * badge is the visible proof the spam requirement works, the mailbox label
 * is what makes a three-mailbox setup legible, and the deadline line is what
 * a glance at Telegram needs to answer "does this need me today".
 *
 * Every untrusted or semi-trusted string -- subject, sender name, the
 * classifier's free-text rationale -- is escaped via escapeTelegramHtml
 * exactly once, here. channels/telegram.ts never escapes anything; this is
 * the only place that can get it wrong, which is the point.
 */
export function composeCard(email: CardEmail, timezone: string): ComposedCard {
  const icon = IMPORTANCE_ICON[email.importance];
  // Escape the COMPOSED string, not the parts. Escaping name and address
  // separately once left the literal angle brackets around the address
  // unescaped and Telegram rejected the whole call. In HTML mode "<" is
  // still the one character that must not slip through, so the lesson holds
  // even though the syntax changed.
  const from = email.fromName
    ? escapeTelegramHtml(`${email.fromName} <${email.fromAddress}>`)
    : escapeTelegramHtml(email.fromAddress);

  const header = [
    `<b>${icon} ${email.importance}</b> · ${escapeTelegramHtml(email.accountLabel)}`,
  ];
  if (email.isSpam) header.push("⚠️ found in SPAM");

  const lines = [
    header.join("  ·  "),
    "",
    `<b>From:</b>     ${from}`,
    `<b>Subject:</b>  ${escapeTelegramHtml(email.subject ?? "(no subject)")}`,
  ];

  if (email.whyItMatters) {
    lines.push("", "<b>Why it matters:</b>", escapeTelegramHtml(email.whyItMatters));
  }

  if (email.deadlineMentioned) {
    const ms = Date.parse(email.deadlineMentioned);
    const formatted = Number.isNaN(ms)
      ? escapeTelegramHtml(email.deadlineMentioned)
      : escapeTelegramHtml(formatInstant(ms, timezone));
    lines.push("", `<b>Deadline mentioned:</b> ${formatted}`);
  }

  const id = email.emailMessageId;
  return {
    // Every interpolated value above went through escapeTelegramHtml; the
    // literals joining them (newlines, the <b> tags, "·") are ours.
    text: alreadyHtml(lines.join("\n")),
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
