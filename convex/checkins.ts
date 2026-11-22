import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { reportIncident } from "./ops";
import { sendMessage } from "./channels/telegram";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { composeCheckin, loadPersona } from "./briefs";
import { allowProactive, legacyChoice } from "./notify";
import { allCalendarEvents } from "./tools/router";
import { whenToMs, isAllDay } from "./lib/calendar/events";
import { dayWindow } from "./lib/calendar/window";
import {
  CHECKINS_PREF_KEY,
  decideCheckin,
  decideWatch,
  personaOrDefault,
  type CheckinSlot,
  type Persona,
  type WatchDecision,
  type WatchEvent,
} from "./lib/personas";

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

    // Opt-in chatter: one cheap read, and a dropped tick composes nothing.
    // An owner who explicitly set /checkins on or off before the attention
    // policy existed keeps that choice (legacy alias for kinds.checkin).
    if (!args.force && (await allowProactive(ctx, user._id, "checkin", { legacyKey: CHECKINS_PREF_KEY, legacy: legacyChoice })) !== "send") {
      return { sent: false, reason: "policy" };
    }

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
      // Last inbound lives on the user row; the last check-in is the one
      // outbound kind we still need, found in the recent window.
      const recent = await ctx.runQuery(internal.model.messages.recentForUser, {
        userId: user._id,
        limit: 50,
      });
      const lastInbound = user.lastInboundAt === undefined ? undefined : { _creationTime: user.lastInboundAt };
      const lastCheckin = recent.filter((m) => m.kind === CHECKIN_KIND).at(-1);

      const decision = decideCheckin({
        persona,
        enabled: loaded.checkinsOn,
        nowMs,
        timezone,
        lastInboundMs: lastInbound?._creationTime,
        lastCheckinMs: lastCheckin?._creationTime,
      });
      if (decision.send) {
        slot = decision.due.slot;
        key = `checkin:${decision.due.key}`;
      } else if (decision.reason === "no_slot" && persona.watch) {
        // Between slots, a watching persona (Corporate PA) checks the
        // calendar and the board itself.
        const watched = await watchCheckin(ctx, user._id, persona, {
          enabled: loaded.checkinsOn,
          nowMs,
          timezone,
          lastInboundMs: lastInbound?._creationTime,
          lastCheckinMs: lastCheckin?._creationTime,
        });
        if (!watched.send) return { sent: false, reason: watched.reason };
        slot = watched.slot;
        key = watched.key;
      } else {
        return { sent: false, reason: decision.reason };
      }

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

/**
 * Load what the watch looks at (events in the next two hours, open tasks)
 * and decide. Reads happen only after the cheap checks pass, so a quiet
 * tick costs no Calendar or Linear call.
 */
async function watchCheckin(
  ctx: ActionCtx,
  userId: Id<"users">,
  persona: Persona,
  base: {
    enabled: boolean;
    nowMs: number;
    timezone: string;
    lastInboundMs?: number;
    lastCheckinMs?: number;
  },
): Promise<WatchDecision> {
  const endOfTodayMs = dayWindow(base.nowMs, base.timezone).endMs;
  const precheck = decideWatch({ ...base, persona, events: [], endOfTodayMs });
  if (!precheck.send && precheck.reason !== "nothing") return precheck;

  let events: WatchEvent[] = [];
  try {
    const found = await allCalendarEvents(
      ctx,
      userId,
      { startMs: base.nowMs, endMs: base.nowMs + 2 * 60 * 60_000 },
      { limit: 10 },
    );
    events = found.events.flatMap(({ event }) => {
      const startMs = whenToMs(event.start, base.timezone);
      if (startMs === null || isAllDay(event.start)) return [];
      return [{ id: event.id, title: event.summary ?? "(no title)", startMs }];
    });
  } catch {
    // No calendar connected: the watch still covers tasks.
  }

  return decideWatch({ ...base, persona, events, endOfTodayMs });
}
