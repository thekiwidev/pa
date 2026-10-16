import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { reportIncident } from "./ops";
import { sendMessage } from "./channels/telegram";
import { composeCheckin, loadPersona } from "./briefs";
import { decideCheckin, personaOrDefault, type CheckinSlot } from "./lib/personas";

/** Outbound messages of this kind are personality check-ins. */
export const CHECKIN_KIND = "checkin";

/**
 * Personality check-ins (2026-10-16). The cron ticks every 30 minutes; the
 * active personality's slots (convex/lib/personas.ts) decide whether this
 * tick sends anything. Each slot goes out at most once a day, never within
 * two hours of another check-in, and waits while the user is mid-
 * conversation. The user's reply is an ordinary message, so "done with
 * THE-89" updates Linear through the normal tools.
 */
export const tick = internalAction({
  args: {
    /** Testing on dev: send the current personality's first slot now. */
    force: v.optional(v.boolean()),
    persona: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!ownerId) return { sent: false, reason: "no_owner" };
    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId: ownerId });
    if (!user) return { sent: false, reason: "no_user" };

    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const nowMs = Date.now();
    const loaded = await loadPersona(ctx, user._id);
    const persona = args.persona ? personaOrDefault(args.persona) : loaded.persona;

    let slot: CheckinSlot;
    let key: string;
    if (args.force) {
      const first = persona.checkins[0];
      if (!first) return { sent: false, reason: "no_slot" };
      slot = first;
      key = `forced:${nowMs}`;
    } else {
      // The last 50 messages (oldest first) always contain the last inbound
      // and last check-in whenever they are recent enough to matter
      // (minutes to two hours).
      const recent = await ctx.runQuery(internal.model.messages.recentForUser, {
        userId: user._id,
        limit: 50,
      });
      const lastInbound = recent.filter((m) => m.direction === "in").at(-1);
      const lastCheckin = recent.filter((m) => m.kind === CHECKIN_KIND).at(-1);

      const decision = decideCheckin({
        persona,
        enabled: loaded.checkinsOn,
        nowMs,
        timezone,
        lastInboundMs: lastInbound?._creationTime,
        lastCheckinMs: lastCheckin?._creationTime,
      });
      if (!decision.send) return { sent: false, reason: decision.reason };
      slot = decision.due.slot;
      key = `checkin:${decision.due.key}`;

      // Claimed BEFORE composing: a slow model call must not let the next
      // tick send the same slot twice. A failed send is reported, not
      // retried — a missed check-in is better than a doubled one.
      const claimed = await ctx.runMutation(internal.model.messages.claimNudge, {
        userId: user._id,
        key,
      });
      if (!claimed) return { sent: false, reason: "already_sent" };
    }

    let text: string;
    let channelMessageId: string;
    try {
      text = await composeCheckin(ctx, user._id, persona, slot);
      if (!text) return { sent: false, reason: "empty" };
      channelMessageId = await sendMessage(user.telegramId, text);
    } catch (error) {
      await reportIncident(ctx, { source: "checkins.tick", error, severity: "warn" });
      return { sent: false, reason: "error" };
    }

    await ctx.runMutation(internal.model.messages.record, {
      userId: user._id,
      channel: "telegram",
      direction: "out",
      channelMessageId,
      kind: CHECKIN_KIND,
      text,
    });
    await ctx.runMutation(internal.model.audit.record, {
      actor: "scheduler",
      action: "checkin.send",
      args: { persona: persona.id, slot: slot.id, key, chars: text.length },
      result: "ok",
    });
    return { sent: true, persona: persona.id, slot: slot.id };
  },
});
