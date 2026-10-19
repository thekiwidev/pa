import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { sendMessage } from "./channels/telegram";
import { reportIncident } from "./ops";
import { formatInstant } from "./lib/time";
import { normalizeCategory, renderUserContext } from "./lib/userContext";
import { NEEDS, resolveNeed, type NeedId } from "./lib/scripture/needs";
import { detectMoment } from "./lib/scripture/moment";
import { formatReference, overlaps, parseReference, type Passage } from "./lib/scripture/reference";
import {
  CHOOSE_SYSTEM,
  PRAYER_SYSTEM,
  checkPrayer,
  parseChoice,
  parsePrayer,
  passageText,
  pointsWanted,
  renderChooseInput,
  renderDevotional,
  renderPrayerInput,
  type PassageVerse,
  type PrayerDraft,
} from "./lib/scripture/devotional";
import {
  SCRIPTURE_PREF_KEY,
  decideMoment,
  decideScripture,
  describeSettings,
  settingsFrom,
  startOfToday,
  type ScriptureSettings,
  type ScriptureTrigger,
  type SentToday,
} from "./lib/scripture/schedule";

/** checkins.ts's CHECKIN_KIND, repeated rather than imported: checkins.ts
 *  imports briefs.ts, which imports this file. */
const CHECKIN_KIND = "checkin";

/** Outbound messages of this kind are verses. */
export const SCRIPTURE_KIND = "scripture";

/** "Not that one again" looks back this far. */
const NO_REPEAT_MS = 30 * 24 * 60 * 60_000;

/**
 * Scripture (2026-10-19). Verses that fit what is going on, through the day:
 *
 *   tick        the cron, every 30 minutes — the morning verse and the
 *               every-couple-of-hours ones (lib/scripture/schedule.ts)
 *   onMessage   after every inbound message — a cheap word check
 *               (lib/scripture/moment.ts) that schedules a verse for
 *               "I'm so stressed", "applying for a job", "I want to give up"
 *   sendNow     /verse, the scripture.send tool, and testing
 *
 * Every path ends in sendDevotional(): choose (model proposes references),
 * look up (code reads the owner's own Bible), pray (model writes, code
 * checks every prayer point quotes the passage), send.
 */
type Outcome = DevotionalResult | { sent: false; reason: string };

export const tick = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Outcome> => {
    const owner = await loadOwner(ctx);
    if (!owner) return { sent: false, reason: "no_user" };
    const { user, settings, timezone } = owner;
    const nowMs = Date.now();

    if (args.force) {
      return await sendDevotional(ctx, user._id, { trigger: "interval" });
    }

    const [today, recent] = await Promise.all([
      sentToday(ctx, user._id, nowMs, timezone),
      ctx.runQuery(internal.model.messages.recentForUser, { userId: user._id, limit: 50 }),
    ]);
    const decision = decideScripture({
      settings,
      nowMs,
      timezone,
      today,
      lastInboundMs: recent.filter((m) => m.direction === "in").at(-1)?._creationTime,
      lastCheckinMs: recent.filter((m) => m.kind === CHECKIN_KIND).at(-1)?._creationTime,
    });
    if (!decision.send) return { sent: false, reason: decision.reason };

    // Claimed BEFORE composing, like check-ins: a slow model call must not
    // let the next tick send the same verse twice.
    const claimed = await ctx.runMutation(internal.model.messages.claimNudge, {
      userId: user._id,
      key: decision.key,
    });
    if (!claimed) return { sent: false, reason: "already_sent" };

    return await sendDevotional(ctx, user._id, {
      trigger: decision.trigger,
      ...(decision.need ? { need: decision.need } : {}),
    });
  },
});

/**
 * Called from assistant.handleMessage for every inbound text. No model call
 * unless the words match, and then a short delay so the verse lands after
 * the reply, not on top of it.
 */
export async function scheduleMomentVerse(
  ctx: ActionCtx,
  userId: Id<"users">,
  text: string,
): Promise<void> {
  const moment = detectMoment(text);
  if (!moment) return;
  await ctx.scheduler.runAfter(45_000, internal.scripture.sendMoment, {
    userId,
    need: moment.need,
    cue: text.slice(0, 400),
  });
}

export const sendMoment = internalAction({
  args: { userId: v.id("users"), need: v.string(), cue: v.string() },
  handler: async (ctx, args): Promise<Outcome> => {
    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const settings = await loadSettings(ctx, args.userId);
    const nowMs = Date.now();
    const today = await sentToday(ctx, args.userId, nowMs, timezone);
    const decision = decideMoment({ settings, nowMs, timezone, today });
    if (!decision.send) return { sent: false, reason: decision.reason };
    const claimed = await ctx.runMutation(internal.model.messages.claimNudge, {
      userId: args.userId,
      key: decision.key,
    });
    if (!claimed) return { sent: false, reason: "already_sent" };
    return await sendDevotional(ctx, args.userId, {
      trigger: "moment",
      need: resolveNeed(args.need) ?? undefined,
      ask: args.cue,
    });
  },
});

/** /verse, the scripture.send tool, and `bunx convex run scripture:sendNow`. */
export const sendNow = internalAction({
  args: {
    userId: v.optional(v.id("users")),
    need: v.optional(v.string()),
    ask: v.optional(v.string()),
    morning: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Outcome> => {
    let userId: Id<"users"> | undefined = args.userId;
    if (!userId) {
      const owner = await loadOwner(ctx);
      if (!owner) return { sent: false, reason: "no_user" };
      userId = owner.user._id;
    }
    return await sendDevotional(ctx, userId, {
      trigger: args.morning ? "morning" : "asked",
      need: resolveNeed(args.need) ?? (args.morning ? "thanksgiving" : undefined),
      ask: args.ask,
    });
  },
});

/**
 * The morning brief sends the morning verse first, so the day opens with
 * thanks before tasks. Shares the tick's claim key, so whichever runs first
 * sends it and the other skips. Never throws: the brief must still go out.
 */
export async function sendMorningBeforeBrief(ctx: ActionCtx, userId: Id<"users">): Promise<void> {
  try {
    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const settings = await loadSettings(ctx, userId);
    if (!settings.enabled) return;
    const nowMs = Date.now();
    const today = await sentToday(ctx, userId, nowMs, timezone);
    if (today.some((s) => s.trigger === "morning")) return;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(nowMs));
    const claimed = await ctx.runMutation(internal.model.messages.claimNudge, {
      userId,
      key: `scripture:morning:${date}`,
    });
    if (!claimed) return;
    await sendDevotional(ctx, userId, { trigger: "morning", need: "thanksgiving" });
  } catch (error) {
    await reportIncident(ctx, { source: "scripture.morning", error, severity: "warn" });
  }
}

/* ── the pipeline ─────────────────────────────────────────────── */

export interface DevotionalRequest {
  trigger: ScriptureTrigger;
  need?: NeedId;
  /** What they asked for, or what they said that made this a moment. */
  ask?: string;
}

export type DevotionalResult =
  | { sent: true; reference: string; need: NeedId; translation: string; prayerChecked: boolean }
  | { sent: false; reason: "no_bible" | "off" | "no_passage" | "error"; detail?: string };

export async function sendDevotional(
  ctx: ActionCtx,
  userId: Id<"users">,
  req: DevotionalRequest,
): Promise<DevotionalResult> {
  const user = await ctx.runQuery(internal.model.users.get, { userId });
  if (!user) return { sent: false, reason: "error", detail: "no user" };
  const settings = await loadSettings(ctx, userId);
  if (!settings.enabled && req.trigger !== "asked") return { sent: false, reason: "off" };

  const translation = await pickTranslation(ctx, settings);
  if (!translation) return { sent: false, reason: "no_bible" };

  try {
    const composed = await compose(ctx, userId, user.displayName, translation, req);
    if (!composed) return { sent: false, reason: "no_passage" };

    const channelMessageId = await sendMessage(user.telegramId, composed.text);
    await ctx.runMutation(internal.model.messages.record, {
      userId,
      channel: "telegram",
      direction: "out",
      channelMessageId,
      kind: SCRIPTURE_KIND,
      text: composed.text,
      ref: { kind: "scripture", id: composed.reference },
    });
    await ctx.runMutation(internal.model.scripture.recordSend, {
      userId,
      trigger: req.trigger,
      need: composed.need,
      translation: translation.code,
      ...composed.passage,
      ...(composed.situation ? { situation: composed.situation.slice(0, 300) } : {}),
      ...(composed.draft ? { prayerOpening: composed.draft.prayer.slice(0, 120) } : {}),
    });
    await ctx.runMutation(internal.model.audit.record, {
      actor: "scheduler",
      action: "scripture.send",
      args: {
        trigger: req.trigger,
        need: composed.need,
        reference: composed.reference,
        translation: translation.code,
        prayerChecked: composed.draft !== null,
      },
      result: "ok",
    });
    return {
      sent: true,
      reference: composed.reference,
      need: composed.need,
      translation: translation.code,
      prayerChecked: composed.draft !== null,
    };
  } catch (error) {
    await reportIncident(ctx, { source: `scripture.${req.trigger}`, error, severity: "warn" });
    return { sent: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

interface Composed {
  text: string;
  reference: string;
  need: NeedId;
  passage: Passage;
  situation: string;
  draft: PrayerDraft | null;
}

async function compose(
  ctx: ActionCtx,
  userId: Id<"users">,
  displayName: string,
  translation: { code: string; name: string },
  req: DevotionalRequest,
): Promise<Composed | null> {
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
  const nowMs = Date.now();
  const firstName = displayName.trim().split(/\s+/)[0] || "friend";

  const [contextRows, summary, messages, sends] = await Promise.all([
    ctx.runQuery(internal.model.userContext.list, { userId }),
    ctx.runQuery(internal.model.messages.getSummary, { userId }),
    ctx.runQuery(internal.model.messages.recentForUser, { userId, limit: 16 }),
    ctx.runQuery(internal.model.scripture.sendsSince, { userId, sinceMs: nowMs - NO_REPEAT_MS, limit: 200 }),
  ]);
  const recentPassages: Passage[] = sends.map((s) => ({
    book: s.book,
    chapter: s.chapter,
    verseStart: s.verseStart,
    verseEnd: s.verseEnd,
  }));

  // The conversation is the user's own words plus what the assistant said,
  // which can quote email. It enters as untrusted data (invariant 2); the
  // chooser's output can only name a need and references, so nothing in it
  // can act.
  const conversation = messages
    .filter((m) => m.text && m.kind !== SCRIPTURE_KIND)
    .map((m) => `${m.direction === "in" ? "them" : "assistant"} (${formatInstant(m._creationTime, timezone)}): ${m.text!.slice(0, 400)}`)
    .join("\n");

  const fallbackNeed: NeedId = req.need ?? (req.trigger === "morning" ? "thanksgiving" : "faith");
  let choice = parseChoice("", fallbackNeed);
  try {
    const result = await runTask("CHOOSE_SCRIPTURE", {
      system: CHOOSE_SYSTEM,
      input: renderChooseInput({
        trigger: req.trigger,
        nowLabel: formatInstant(nowMs, timezone),
        firstName,
        ...(req.need ? { need: req.need } : {}),
        ...(req.ask ? { ask: req.ask.slice(0, 400) } : {}),
        about: renderUserContext(contextRows.map((c) => ({ category: normalizeCategory(c.category), text: c.text }))),
        recentlySent: sends.slice(0, 25).map((s) => formatReference(s)),
      }),
      untrusted: [
        ...(summary?.summary ? [{ label: "conversation-summary", content: summary.summary }] : []),
        ...(conversation ? [{ label: "recent-conversation", content: conversation }] : []),
      ],
      json: true,
      maxOutputTokens: 400,
    });
    choice = parseChoice(result.text, fallbackNeed);
  } catch (error) {
    // No model: the shelf still has a verse for the need. A verse without a
    // tailored choice beats no verse.
    console.warn(`scripture_choose_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A forced need (the morning, an explicit ask) wins over the model's.
  const need = req.need ?? choice.need;

  const found = await resolvePassage(ctx, translation.code, need, choice, recentPassages);
  if (!found) return null;
  const reference = formatReference(found.passage);
  const text = passageText(found.verses);

  const minPoints = Math.min(2, pointsWanted(req.trigger));
  let draft: PrayerDraft | null = null;
  let problems: string[] | undefined;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    try {
      const result = await runTask("WRITE_PRAYER", {
        system: PRAYER_SYSTEM,
        input: renderPrayerInput({
          trigger: req.trigger,
          firstName,
          reference,
          translation: translation.code,
          passageText: text,
          situation: choice.situation || req.ask || "",
          need,
          recentPrayers: sends.flatMap((s) => (s.prayerOpening ? [s.prayerOpening] : [])).slice(0, 6),
          ...(problems ? { problems } : {}),
        }),
        json: true,
        maxOutputTokens: 900,
      });
      const parsed = parsePrayer(result.text);
      if (!parsed) {
        problems = ["the reply was not the JSON object asked for"];
        continue;
      }
      const checked = checkPrayer(text, parsed, minPoints);
      if (checked.ok) draft = checked.draft;
      else problems = checked.problems;
    } catch (error) {
      console.warn(`scripture_prayer_failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  return {
    text: renderDevotional({
      trigger: req.trigger,
      need,
      firstName,
      passage: found.passage,
      translation: translation.code,
      verses: found.verses,
      draft,
    }),
    reference,
    need,
    passage: found.passage,
    situation: choice.situation,
    draft,
  };
}

/**
 * The first proposal that exists in this Bible and was not sent in the last
 * 30 days; then a word search; then the shelf. Each step is a lookup in the
 * owner's own Bible, so the text is always what is printed there.
 */
async function resolvePassage(
  ctx: ActionCtx,
  translation: string,
  need: NeedId,
  choice: { passages: Passage[]; searchWords: string[] },
  recent: Passage[],
): Promise<{ passage: Passage; verses: PassageVerse[] } | null> {
  const fresh = (p: Passage) => !recent.some((r) => overlaps(r, p));
  const lookup = async (p: Passage) => {
    const verses = await ctx.runQuery(internal.model.scripture.getPassage, { translation, ...p });
    if (verses.length === 0) return null;
    // A range that runs past the chapter's end is cut to what exists.
    const last = verses[verses.length - 1]!.verse;
    return { passage: { ...p, verseStart: verses[0]!.verse, verseEnd: last }, verses };
  };

  for (const p of choice.passages.filter(fresh)) {
    const hit = await lookup(p);
    if (hit) return hit;
  }

  if (choice.searchWords.length) {
    const hits = await ctx.runQuery(internal.model.scripture.search, {
      translation,
      query: choice.searchWords.join(" "),
      limit: 10,
    });
    const first = hits
      .map((h) => ({ book: h.book, chapter: h.chapter, verseStart: h.verse, verseEnd: h.verse }))
      .find(fresh);
    if (first) {
      const hit = await lookup(first);
      if (hit) return hit;
    }
  }

  const shelf = NEEDS[need].shelf
    .map((r) => parseReference(r))
    .filter((p): p is Passage => p !== null);
  const unsent = shelf.filter(fresh);
  // Rotate through the shelf rather than always taking the top.
  const ordered = unsent.length ? shuffle(unsent) : shuffle(shelf);
  for (const p of ordered) {
    const hit = await lookup(p);
    if (hit) return hit;
  }
  return null;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* ── settings ─────────────────────────────────────────────────── */

export interface SettingsPatch {
  enabled?: boolean;
  translation?: string;
  morning?: string;
  gapMinutes?: number;
}

export type SettingsResult =
  | { ok: true; text: string; settings: ScriptureSettings }
  | { ok: false; text: string; available: string[] };

/** Apply a change (or none) and describe the result. Shared by /scripture and the tool. */
export async function updateSettings(
  ctx: ActionCtx,
  userId: Id<"users">,
  patch: SettingsPatch,
): Promise<SettingsResult> {
  const translations = await ctx.runQuery(internal.model.scripture.listTranslations, {});
  const current = await loadSettings(ctx, userId);
  const next: ScriptureSettings = { ...current };
  if (patch.translation !== undefined) {
    const code = patch.translation.trim().toUpperCase();
    if (!translations.some((t) => t.code === code)) {
      const available = translations.map((t) => t.code);
      return {
        ok: false,
        available,
        text: available.length
          ? `I don't have ${code} imported. I have: ${available.join(", ")}.`
          : `I don't have ${code} — no Bible is imported yet. docs/SCRIPTURE.md explains how.`,
      };
    }
    next.translation = code;
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.morning !== undefined) next.morning = patch.morning;
  if (patch.gapMinutes !== undefined) next.gapMinutes = patch.gapMinutes;
  const settings = settingsFrom(next);
  if (Object.keys(patch).length > 0) {
    await ctx.runMutation(internal.model.preferences.set, { userId, key: SCRIPTURE_PREF_KEY, value: settings });
  }
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
  const today = await sentToday(ctx, userId, Date.now(), timezone);
  return { ok: true, settings, text: describeSettings(settings, translations, today.length) };
}

/* ── loading ──────────────────────────────────────────────────── */

async function loadOwner(
  ctx: ActionCtx,
): Promise<{ user: Doc<"users">; settings: ScriptureSettings; timezone: string } | null> {
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return null;
  const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId: ownerId });
  if (!user) return null;
  return {
    user,
    settings: await loadSettings(ctx, user._id),
    timezone: process.env.USER_TIMEZONE ?? "Africa/Lagos",
  };
}

export async function loadSettings(ctx: ActionCtx, userId: Id<"users">): Promise<ScriptureSettings> {
  const stored = await ctx.runQuery(internal.model.preferences.get, { userId, key: SCRIPTURE_PREF_KEY });
  return settingsFrom(stored);
}

/** The chosen translation when it is imported, else the first one imported. */
export async function pickTranslation(
  ctx: ActionCtx,
  settings: ScriptureSettings,
): Promise<{ code: string; name: string } | null> {
  const all = await ctx.runQuery(internal.model.scripture.listTranslations, {});
  if (all.length === 0) return null;
  const chosen = settings.translation ? all.find((t) => t.code === settings.translation) : undefined;
  const t = chosen ?? all[0]!;
  return { code: t.code, name: t.name };
}

async function sentToday(
  ctx: ActionCtx,
  userId: Id<"users">,
  nowMs: number,
  timezone: string,
): Promise<SentToday[]> {
  const rows = await ctx.runQuery(internal.model.scripture.sendsSince, {
    userId,
    sinceMs: startOfToday(nowMs, timezone),
    limit: 50,
  });
  return rows.map((r) => ({ trigger: r.trigger as ScriptureTrigger, sentAt: r.sentAt }));
}
