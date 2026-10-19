// Pure. The two model calls behind every verse, and the code that checks
// what they return.
//
//   1. CHOOSE_SCRIPTURE reads what is going on and PROPOSES references —
//      never verse text. convex/scripture.ts looks each one up in the Bible
//      the owner imported; a reference that is not there is dropped.
//   2. WRITE_PRAYER is handed the passage as it is printed and writes a
//      short reflection, prayer points and a prayer. Every prayer point must
//      quote the words of the passage it grows out of (`anchor`), and
//      checkPrayer() verifies each quote against the passage text. A point
//      that cannot show where in the verse it came from is not sent.
//
// That second check is what "the prayer has to make sense with the verse"
// means in code: the depth is the model's job, but the tie to the text is
// verified, not hoped for.

import { describeNeeds, NEEDS, NEED_IDS, resolveNeed, type NeedId } from "./needs";
import { formatReference, parseReference, type Passage } from "./reference";
import { parseJsonObject } from "../json";
import type { ScriptureTrigger } from "./schedule";

/* ── 1. choosing ──────────────────────────────────────────────── */

export const CHOOSE_SYSTEM = `You choose ONE Bible passage for the user, right now, as a wise friend
and pastor would: someone who knows their week and knows the Bible well.

WHAT THE PASSAGE IS FOR — pick the one need that fits what is actually going on:
${describeNeeds()}

HOW TO CHOOSE
- Read the conversation and what you know about them first. Name what is
  really going on (the job application, the argument, the deadline, the
  quiet drift from prayer) — not a generic mood.
- When a need is given, use it. Otherwise choose the need yourself.
- The morning verse is ALWAYS thanksgiving: grateful, brief, mostly from
  Psalms, and where possible tied to what today holds for them.
- "Keep me in check" means honest correction, not condemnation: choose it
  when the conversation shows pride, temptation, harshness, laziness or a
  shortcut, even if they did not ask for it.
- Prefer the SHELF below for the chosen need. You may propose any other
  passage you are certain of — references only; the text comes from their
  own Bible, so a wrong reference is simply discarded.
- 1 to 3 verses. Never a whole chapter.
- Read the verse in its context. Never use a line spoken by a fool, an
  enemy or Job's comforters as if it were God's promise, and never turn a
  verse into a promise it does not make.
- Do not repeat anything in RECENTLY SENT.

SHELF
${NEED_IDS.map((id) => `${id}: ${NEEDS[id].shelf.join("; ")}`).join("\n")}

OUTPUT — one JSON object, nothing else:
{"need": "<one need id>",
 "situation": "<one sentence, second person: what is going on for them right now>",
 "references": ["<Book chapter:verse(-verse)>", "<next best>", "<third>"],
 "searchWords": ["<2-4 words a fitting verse would contain>"]}`;

export interface Choice {
  need: NeedId;
  situation: string;
  passages: Passage[];
  searchWords: string[];
}

/** Lenient: an unknown need falls back to the forced or default one, bad references are dropped. */
export function parseChoice(raw: string, fallbackNeed: NeedId): Choice {
  const obj = parseJsonObject(raw) ?? {};
  const need = resolveNeed(obj.need) ?? fallbackNeed;
  const refs = Array.isArray(obj.references) ? obj.references : [];
  const passages = refs
    .filter((r): r is string => typeof r === "string")
    .map((r) => parseReference(r))
    .filter((p): p is Passage => p !== null)
    .slice(0, 5);
  const words = Array.isArray(obj.searchWords) ? obj.searchWords : [];
  return {
    need,
    situation: typeof obj.situation === "string" ? obj.situation.trim().slice(0, 300) : "",
    passages,
    searchWords: words.filter((w): w is string => typeof w === "string" && w.trim().length > 1).slice(0, 4),
  };
}

export interface ChooseInput {
  trigger: ScriptureTrigger;
  nowLabel: string;
  firstName: string;
  need?: NeedId;
  /** What the user asked for, or the words that triggered a moment. */
  ask?: string;
  /** What we know about them (userContext). */
  about: string;
  recentlySent: string[];
}

export function renderChooseInput(i: ChooseInput): string {
  return [
    `NOW: ${i.nowLabel}`,
    `NAME: ${i.firstName}`,
    `WHY THIS VERSE: ${triggerLine(i.trigger)}`,
    i.need ? `NEED (use this one): ${i.need}` : "NEED: choose it yourself",
    i.ask ? `WHAT THEY SAID: ${i.ask}` : "",
    "",
    "WHAT YOU KNOW ABOUT THEM",
    i.about || "  (nothing recorded)",
    "",
    "RECENTLY SENT (do not repeat)",
    i.recentlySent.length ? i.recentlySent.map((r) => `  - ${r}`).join("\n") : "  (none)",
  ]
    .filter((l, idx, all) => l !== "" || all[idx - 1] !== "")
    .join("\n");
}

function triggerLine(trigger: ScriptureTrigger): string {
  switch (trigger) {
    case "morning":
      return "their morning verse — the first thing they read today";
    case "interval":
      return "an unprompted verse during the day, about whatever is going on now";
    case "moment":
      return "something they just said sounds like it needs a verse right now";
    case "asked":
      return "they asked for a verse";
  }
}

/* ── 2. praying ───────────────────────────────────────────────── */

export const PRAYER_SYSTEM = `You help the user pray a Bible passage into their actual day. You are
handed the passage exactly as printed in their Bible, and what is going on.

Write:
1. "reflection" — 1 or 2 sentences. What this passage actually says in its
   context (who is speaking, promise or command or confession), and the
   one way it meets their situation. Specific, not a sermon.
2. "points" — prayer points. Each one:
   - "anchor": a phrase of 2 to 10 words COPIED EXACTLY from the passage,
     same spelling, same old English if it is old English.
   - "prayer": one or two first-person sentences addressed to God that
     grow out of THAT phrase: what the phrase reveals (about God, a
     promise, a command, a warning) turned into a concrete request or
     surrender about their situation today. The phrase must be the reason
     for the request — someone reading it should see the line from the
     words to the prayer.
   Use a different phrase for each point, in the order they appear.
3. "prayer" — a closing prayer of 2 to 4 sentences, first person, that
   gathers the points into one honest prayer about their real situation,
   ending "in Jesus' name, Amen."

DEPTH AND HONESTY
- No filler: never "bless me", "help me in all I do", "be with me today"
  on their own. Every line names something real.
- Say what the passage says, not more. A command stays a command (ask for
  grace to obey it); a lament is prayed as honest lament; do not promise
  outcomes the verse does not promise (it does not guarantee they get the
  job — it may promise God's presence, provision or direction in it).
- Fresh words every time. Do not open the same way as any line in
  RECENT PRAYERS, and do not reuse their phrasing.
- No other Bible verses, no quotation of anything but this passage.
- Warm, plain, sincere. Not churchy jargon, not a performance.

OUTPUT — one JSON object, nothing else:
{"reflection": "...", "points": [{"anchor": "...", "prayer": "..."}], "prayer": "..."}`;

export interface PrayerInput {
  trigger: ScriptureTrigger;
  firstName: string;
  reference: string;
  translation: string;
  passageText: string;
  situation: string;
  need: NeedId;
  recentPrayers: string[];
  /** Set on the retry: what was wrong with the first draft. */
  problems?: string[];
}

/** How many prayer points to ask for. The morning one stays brief. */
export function pointsWanted(trigger: ScriptureTrigger): number {
  return trigger === "morning" ? 2 : 3;
}

export function renderPrayerInput(i: PrayerInput): string {
  return [
    `PASSAGE: ${i.reference} (${i.translation})`,
    i.passageText,
    "",
    `NEED: ${i.need} — ${NEEDS[i.need].label}`,
    `WHAT IS GOING ON: ${i.situation || "(nothing specific; pray it into an ordinary day)"}`,
    `NAME: ${i.firstName}`,
    `PRAYER POINTS WANTED: ${pointsWanted(i.trigger)}`,
    i.trigger === "morning" ? "This is the morning verse: keep everything brief and grateful." : "",
    "",
    "RECENT PRAYERS (do not open the same way)",
    i.recentPrayers.length ? i.recentPrayers.map((p) => `  - ${p}`).join("\n") : "  (none)",
    ...(i.problems?.length
      ? ["", "YOUR LAST DRAFT WAS REJECTED BECAUSE:", ...i.problems.map((p) => `  - ${p}`), "Fix exactly these."]
      : []),
  ]
    .filter((l, idx, all) => l !== "" || all[idx - 1] !== "")
    .join("\n");
}

export interface PrayerPoint {
  anchor: string;
  prayer: string;
}

export interface PrayerDraft {
  reflection: string;
  points: PrayerPoint[];
  prayer: string;
}

export function parsePrayer(raw: string): PrayerDraft | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;
  const points = (Array.isArray(obj.points) ? obj.points : [])
    .map((p) => p as Record<string, unknown>)
    .filter((p) => typeof p?.anchor === "string" && typeof p?.prayer === "string")
    .map((p) => ({ anchor: (p.anchor as string).trim(), prayer: (p.prayer as string).trim() }));
  return {
    reflection: typeof obj.reflection === "string" ? obj.reflection.trim() : "",
    points,
    prayer: typeof obj.prayer === "string" ? obj.prayer.trim() : "",
  };
}

/** Words only: lower-case, letters and digits, apostrophes folded. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/'s\b/g, "s")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does `anchor` appear in `passage`? Exact word sequence first; otherwise at
 * least 80% of its words must appear in the passage IN ORDER, so a model that
 * modernises one word ("thee" → "you") still passes but an invented phrase
 * does not.
 */
export function anchorInPassage(anchor: string, passage: string): boolean {
  const a = words(anchor);
  const p = words(passage);
  if (a.length < 2) return false;
  if (` ${p.join(" ")} `.includes(` ${a.join(" ")} `)) return true;
  let matched = 0;
  let cursor = 0;
  for (const w of a) {
    const at = p.indexOf(w, cursor);
    if (at === -1) continue;
    matched++;
    cursor = at + 1;
  }
  return matched / a.length >= 0.8;
}

const FILLER = /^(lord,? )?(please )?(bless me|be with me|help me in (all|everything))\b/i;

export interface PrayerCheck {
  ok: boolean;
  draft: PrayerDraft;
  problems: string[];
}

/**
 * Keep only prayer points that quote the passage, use a different phrase each,
 * and say something. ok when the reflection and the closing prayer exist and
 * at least `minPoints` points survive.
 */
export function checkPrayer(passageText: string, draft: PrayerDraft, minPoints: number): PrayerCheck {
  const problems: string[] = [];
  const kept: PrayerPoint[] = [];
  const usedAnchors = new Set<string>();
  for (const point of draft.points) {
    const key = words(point.anchor).join(" ");
    if (!anchorInPassage(point.anchor, passageText)) {
      problems.push(`anchor "${point.anchor}" is not in the passage — copy the words exactly`);
      continue;
    }
    if (usedAnchors.has(key)) {
      problems.push(`anchor "${point.anchor}" is used twice — each point needs its own phrase`);
      continue;
    }
    if (point.prayer.length < 25 || FILLER.test(point.prayer)) {
      problems.push(`the point on "${point.anchor}" is too thin — say what the words reveal and what you are asking`);
      continue;
    }
    usedAnchors.add(key);
    kept.push({ anchor: point.anchor, prayer: point.prayer.slice(0, 420) });
  }
  if (!draft.reflection) problems.push("the reflection is missing");
  if (draft.prayer.length < 40) problems.push("the closing prayer is missing or too short");
  if (kept.length < minPoints) problems.push(`only ${kept.length} usable prayer point(s); ${minPoints} needed`);
  return {
    ok: Boolean(draft.reflection) && draft.prayer.length >= 40 && kept.length >= minPoints,
    draft: {
      reflection: draft.reflection.slice(0, 500),
      points: kept.slice(0, 3),
      prayer: draft.prayer.slice(0, 900),
    },
    problems,
  };
}

/* ── 3. rendering ─────────────────────────────────────────────── */

export interface PassageVerse {
  verse: number;
  text: string;
}

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => String(n).replace(/\d/g, (d) => SUPERSCRIPT[Number(d)]!);

/** The passage as one paragraph, verse numbers in superscript when there is more than one. */
export function passageText(verses: PassageVerse[]): string {
  if (verses.length === 1) return verses[0]!.text;
  return verses.map((v) => `${sup(v.verse)} ${v.text}`).join(" ");
}

export interface DevotionalView {
  trigger: ScriptureTrigger;
  need: NeedId;
  firstName: string;
  passage: Passage;
  translation: string;
  verses: PassageVerse[];
  /** Null when no prayer draft passed checkPrayer: the verse still goes out. */
  draft: PrayerDraft | null;
}

/** Strip the markers the Telegram converter would read as formatting. */
const plain = (s: string) => s.replace(/[*_`~]/g, "");

export function renderDevotional(v: DevotionalView): string {
  const need = NEEDS[v.need];
  const header =
    v.trigger === "morning" ? `🌅 **Good morning, ${plain(v.firstName)}.**` : `${need.emoji} **${need.label}**`;
  const lines = [
    header,
    "",
    `**${formatReference(v.passage)}** (${v.translation})`,
    `> ${plain(passageText(v.verses))}`,
  ];
  if (v.draft) {
    lines.push("", plain(v.draft.reflection));
    if (v.draft.points.length) {
      lines.push("", "**Pray it:**");
      for (const p of v.draft.points) lines.push(`- "${plain(p.anchor)}" — ${plain(p.prayer)}`);
    }
    lines.push("", `🙏 ${plain(v.draft.prayer)}`);
  } else {
    lines.push("", "Read it slowly twice, then tell God plainly what it stirs in you.");
  }
  return lines.join("\n");
}
