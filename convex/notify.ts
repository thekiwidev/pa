import { internalAction } from "./_generated/server";
import { internal, components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { sendCard, editCard, sendMessage, type InlineButton } from "./channels/telegram";
import { escapeTelegramHtml, alreadyHtml } from "./lib/telegram/html";
import type { TelegramHtml } from "./lib/telegram/html";
import { formatInstant, formatWhen } from "./lib/time";
import { DEDUP_WINDOW_MS } from "./model/notifications";
import { IMPORTANCE_ICON } from "./lib/email/classification";
import { renderSummaryHtml, summaryAsPlainText } from "./lib/email/links";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  NOTIFY_PREF_KEY,
  applyNotifyPatch,
  decideSend,
  describeNotify,
  notifyFrom,
  quietHoursEndMs,
  type NotifyKind,
  type NotifyPatch,
  type SendDecision,
} from "./lib/notify/policy";

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
  NEVER_CATEGORY: "nevercat",
  NEWS_UP: "newsup",
  NEWS_DOWN: "newsdown",
} as const;

export interface CardEmail {
  emailMessageId: string;
  accountLabel: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  isSpam: boolean;
  /** SPF/DKIM/DMARC verdicts. Decide whether a link in the sentence may be
   *  tappable — see lib/email/links.ts. Absent = no link is. */
  authResults?: { spf: string; dkim: string; dmarc: string };
  importance: "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "IGNORE";
  whyItMatters?: string;
  /** ISO 8601, Phase 4's ImportanceSchema.deadlineMentioned shape -- or
   *  undefined/null when the classifier found no deadline. */
  deadlineMentioned?: string | null;
  /** When the email arrived (ms epoch), from Gmail's internalDate. */
  receivedAt?: number;
  /** A first line above the card, e.g. the 48h-unread reminder. Our own text. */
  lead?: string;
}

export interface ComposedCard {
  text: TelegramHtml;
  buttons: InlineButton[][];
}



/**
 * Pure. The alert a PA would send — docs/BEHAVIOUR.md §2:
 *
 *   🟠 Polaris Bank · primary · today 09:42
 *   Your ₦150,000 transfer to Adedotun Gabriel went through.
 *   Transfer Successful
 *
 * 2026-10-17: line 2 is now the whole alert — what it says and what to do,
 * up to three sentences — with its links rendered by renderSummaryHtml,
 * which only makes a link tappable when it provably belongs to the sender.
 *
 * Line 1 says who, which mailbox and WHEN (the old card had no time at all,
 * which is why "when did this come in?" was the first follow-up). Line 2 is
 * the classifier's one sentence. The subject is kept, small, so the email can
 * still be recognised. The old From:/Subject:/Why it matters: form read like
 * a ticket, not a person.
 *
 * Every untrusted or semi-trusted string -- subject, sender name, the
 * classifier's free-text rationale -- is escaped via escapeTelegramHtml
 * exactly once, here. channels/telegram.ts never escapes anything.
 */
export function composeCard(email: CardEmail, timezone: string, nowMs = Date.now()): ComposedCard {
  const icon = IMPORTANCE_ICON[email.importance];
  const sender = escapeTelegramHtml(email.fromName?.trim() || email.fromAddress);

  const head = [`${icon} <b>${sender}</b>`, escapeTelegramHtml(email.accountLabel)];
  if (email.receivedAt !== undefined) head.push(formatWhen(email.receivedAt, nowMs, timezone));
  if (email.isSpam) head.push("⚠️ found in SPAM");

  const lines = email.lead ? [`⏰ <b>${escapeTelegramHtml(email.lead)}</b>`] : [];
  lines.push(head.join(" · "));
  lines.push(
    email.whyItMatters
      ? renderSummaryHtml(email.whyItMatters, {
          fromAddress: email.fromAddress,
          labelIds: email.isSpam ? ["SPAM"] : [],
          authResults: email.authResults,
        })
      : `From ${escapeTelegramHtml(email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress)}`,
  );
  lines.push(`<i>${escapeTelegramHtml(email.subject ?? "(no subject)")}</i>`);

  if (email.deadlineMentioned) {
    const ms = Date.parse(email.deadlineMentioned);
    const formatted = Number.isNaN(ms)
      ? escapeTelegramHtml(email.deadlineMentioned)
      : escapeTelegramHtml(formatInstant(ms, timezone));
    lines.push(`⏰ Deadline: ${formatted}`);
  }

  const id = email.emailMessageId;
  return {
    // Every interpolated value above went through escapeTelegramHtml or
    // renderSummaryHtml (which escapes every text run itself); the literals
    // joining them (newlines, the <b>/<i> tags, "·") are ours.
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

/** The alert as plain text, for the conversation history the planner reads. */
export function cardAsHistory(email: CardEmail, timezone: string, nowMs = Date.now()): string {
  const when = email.receivedAt !== undefined ? `, ${formatWhen(email.receivedAt, nowMs, timezone)}` : "";
  return (
    `[Email alert] ${email.fromName?.trim() || email.fromAddress} (${email.accountLabel}${when}): ` +
    `${email.whyItMatters ? summaryAsPlainText(email.whyItMatters) : (email.subject ?? "(no subject)")} — subject "${email.subject ?? "(no subject)"}"`
  );
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
    authResults: v.optional(v.object({ spf: v.string(), dkim: v.string(), dmarc: v.string() })),
    importance: v.string(),
    whyItMatters: v.optional(v.string()),
    deadlineMentioned: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
    lead: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email: CardEmail = {
      emailMessageId: args.emailMessageId,
      accountLabel: args.accountLabel,
      fromAddress: args.fromAddress,
      fromName: args.fromName,
      subject: args.subject,
      isSpam: args.isSpam,
      authResults: args.authResults,
      importance: args.importance as CardEmail["importance"],
      whyItMatters: args.whyItMatters,
      deadlineMentioned: args.deadlineMentioned,
      receivedAt: args.receivedAt,
      lead: args.lead,
    };
    const card = composeCard(email, args.timezone);

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

    // Into the conversation, with a ref to the email: a Reply to this card
    // (or "when did this come in?" right after it) is now about THIS email.
    await ctx.runMutation(internal.model.messages.record, {
      userId: args.userId,
      channel: "telegram",
      direction: "out",
      channelMessageId,
      kind: "alert",
      text: cardAsHistory(email, args.timezone),
      ref: { kind: "email", id: args.emailMessageId },
    });

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

/**
 * The attention gate. Every unprompted sender calls this BEFORE it composes
 * or sends, so a message the policy would drop costs no model call and no
 * Gatherer read. One query reads the owner's activity and notify prefs.
 *
 * `legacy` carries an owner's explicit older switch (persona check-ins,
 * scripture settings) when the new per-kind switch is unset, so nothing the
 * owner turned on before is silently turned off.
 */
export async function allowProactive(
  ctx: ActionCtx,
  userId: Id<"users">,
  kind: NotifyKind,
  opts: {
    /** The older preference key this kind replaces, read in the same query. */
    legacyKey?: string;
    /** How to read that key's raw value: true/false = explicit, undefined = never set. */
    legacy?: (raw: unknown) => boolean | undefined;
    urgent?: boolean;
  } = {},
): Promise<SendDecision> {
  const { lastInboundAt, notify, legacyRaw } = await ctx.runQuery(internal.model.users.attention, {
    userId,
    legacyKey: opts.legacyKey,
  });
  const stored = notifyFrom(notify);
  const legacy = opts.legacy?.(legacyRaw);
  const prefs =
    legacy !== undefined && stored.kinds[kind] === undefined
      ? { ...stored, kinds: { ...stored.kinds, [kind]: legacy } }
      : stored;
  return decideSend({
    kind,
    prefs,
    now: Date.now(),
    lastInboundAt,
    tz: process.env.USER_TIMEZONE ?? "Africa/Lagos",
    urgent: opts.urgent,
  });
}

/** When quiet hours next end, for moving a deferred alert instead of losing it. */
export async function quietEndMs(ctx: ActionCtx, userId: Id<"users">): Promise<number> {
  const { notify } = await ctx.runQuery(internal.model.users.attention, { userId });
  return quietHoursEndMs(notifyFrom(notify), Date.now(), process.env.USER_TIMEZONE ?? "Africa/Lagos");
}

/** For stored switches that were plain booleans (persona.checkins). */
export const legacyChoice = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);

/** For stored objects with an `enabled` flag (scripture). */
export const legacyEnabled = (raw: unknown): boolean | undefined =>
  typeof raw === "object" && raw !== null && typeof (raw as { enabled?: unknown }).enabled === "boolean"
    ? (raw as { enabled: boolean }).enabled
    : undefined;

/**
 * Apply a settings change (or none) and describe the result. The one writer
 * of the `notify` preference: /silent, /quiet, /resume, /notify, the
 * notify.settings tool and the older check-in and verse switches all land here.
 */
export async function updateNotify(ctx: ActionCtx, userId: Id<"users">, patch: NotifyPatch = {}): Promise<string> {
  const now = Date.now();
  const { lastInboundAt, notify } = await ctx.runQuery(internal.model.users.attention, { userId });
  let prefs = notifyFrom(notify);
  if (Object.keys(patch).length > 0) {
    prefs = applyNotifyPatch(prefs, patch, now);
    await ctx.runMutation(internal.model.preferences.set, { userId, key: NOTIFY_PREF_KEY, value: prefs });
  }
  const tz = process.env.USER_TIMEZONE ?? "Africa/Lagos";
  return describeNotify(prefs, now, lastInboundAt, (ms) => formatInstant(ms, tz));
}
