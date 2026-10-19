// Pure. What a verse is FOR, and a hand-picked shelf of passages for each.
//
// The needs are the owner's own words (2026-10-19): verses for affirmation,
// for keeping their walk with God right, to reinforce faith, to keep them
// going, to put a smile on their face, to keep them in check, to calm down,
// and a grateful one — mostly Psalms — to start the morning. Work and
// guidance are there because "I'm applying for a job" was the example.
//
// The shelf is a floor, not a ceiling. The chooser may propose any passage
// in the Bible; the shelf is what it is shown as good examples, and what a
// failed or unavailable model call falls back to. Every reference was read
// against the KJV on 2026-10-19; tests/unit/scripture.test.ts keeps them
// parseable, and `bun scripts/import-bible.ts --check <file>` proves each one
// exists in a file before it is imported.

export type NeedId =
  | "thanksgiving"
  | "affirmation"
  | "walk"
  | "faith"
  | "perseverance"
  | "joy"
  | "check"
  | "peace"
  | "work"
  | "guidance";

export interface Need {
  id: NeedId;
  label: string;
  emoji: string;
  /** For the chooser: when this need is the right one. */
  when: string;
  /** Hand-picked passages, as references parseReference() accepts. */
  shelf: string[];
}

export const NEEDS: Record<NeedId, Need> = {
  thanksgiving: {
    id: "thanksgiving",
    label: "Thanksgiving",
    emoji: "🌅",
    when: "the morning, good news, an answered prayer, a win, a quiet ordinary day worth being grateful for",
    shelf: [
      "Psalm 118:24",
      "Psalm 100:4-5",
      "Psalm 103:1-5",
      "Lamentations 3:22-23",
      "Psalm 5:3",
      "Psalm 92:1-2",
      "Psalm 136:1",
      "Psalm 143:8",
      "Psalm 9:1-2",
      "Psalm 107:1",
      "Psalm 34:1-3",
      "Psalm 16:11",
      "Psalm 63:1-4",
      "1 Thessalonians 5:16-18",
      "James 1:17",
      "Psalm 30:11-12",
    ],
  },
  affirmation: {
    id: "affirmation",
    label: "Who God says you are",
    emoji: "🕊️",
    when: "self-doubt, rejection, feeling small, comparing themselves, impostor feelings, after a no",
    shelf: [
      "Psalm 139:14",
      "Ephesians 2:10",
      "Jeremiah 29:11",
      "Isaiah 43:1-2",
      "Romans 8:37-39",
      "1 Peter 2:9",
      "2 Corinthians 5:17",
      "Zephaniah 3:17",
      "Isaiah 41:10",
      "Romans 8:1",
      "Galatians 2:20",
      "1 John 3:1",
      "Deuteronomy 31:6",
      "Philippians 1:6",
    ],
  },
  walk: {
    id: "walk",
    label: "Walking right with God",
    emoji: "🧭",
    when: "drifting from prayer or the Word, busyness crowding God out, wanting to get their relationship with God right, repentance",
    shelf: [
      "Micah 6:8",
      "Psalm 51:10-12",
      "Matthew 6:33",
      "James 4:8",
      "Psalm 119:105",
      "Proverbs 3:5-6",
      "John 15:4-5",
      "Romans 12:1-2",
      "Psalm 1:1-3",
      "1 John 1:9",
      "Colossians 3:23-24",
      "Joshua 1:8",
      "Psalm 139:23-24",
      "Galatians 5:16",
    ],
  },
  faith: {
    id: "faith",
    label: "Faith",
    emoji: "✝️",
    when: "doubt, waiting on God, an outcome they cannot control, a prayer not yet answered, fear of the future",
    shelf: [
      "Hebrews 11:1",
      "Hebrews 11:6",
      "Mark 11:22-24",
      "Romans 8:28",
      "2 Corinthians 5:7",
      "Mark 9:23-24",
      "Matthew 17:20",
      "Numbers 23:19",
      "Romans 10:17",
      "Habakkuk 2:3",
      "Isaiah 40:31",
      "Psalm 27:13-14",
      "Hebrews 10:23",
      "James 1:5-6",
      "Ephesians 3:20",
    ],
  },
  perseverance: {
    id: "perseverance",
    label: "Keep going",
    emoji: "🔥",
    when: "tired, burnt out, wanting to give up, a long grind, setbacks, repeated failures, a hard week",
    shelf: [
      "Galatians 6:9",
      "Isaiah 40:29-31",
      "Philippians 4:13",
      "2 Corinthians 4:16-18",
      "Hebrews 12:1-2",
      "Philippians 3:13-14",
      "James 1:2-4",
      "Romans 5:3-5",
      "1 Corinthians 15:58",
      "Joshua 1:9",
      "2 Timothy 4:7",
      "Psalm 73:26",
      "Matthew 11:28-30",
      "2 Corinthians 12:9",
    ],
  },
  joy: {
    id: "joy",
    label: "Joy",
    emoji: "😊",
    when: "low mood, sadness, loneliness, a grey day, needing a smile",
    shelf: [
      "Nehemiah 8:10",
      "Psalm 16:11",
      "Philippians 4:4",
      "Psalm 30:5",
      "Proverbs 17:22",
      "Psalm 126:2-3",
      "Romans 15:13",
      "John 15:11",
      "Psalm 34:8",
      "Isaiah 55:12",
      "Psalm 37:4",
      "Zephaniah 3:17",
      "Psalm 28:7",
      "John 16:22",
    ],
  },
  check: {
    id: "check",
    label: "Keep me in check",
    emoji: "⚖️",
    when: "pride, temptation, cutting corners, harsh words, revenge, laziness, procrastination, wasting time, careless speech, a decision with an integrity question",
    shelf: [
      "Proverbs 16:18",
      "James 1:19-20",
      "Galatians 6:7-8",
      "Proverbs 4:23",
      "1 Corinthians 10:12-13",
      "Proverbs 10:9",
      "Ephesians 4:29",
      "Proverbs 6:6-8",
      "Ephesians 5:15-16",
      "Proverbs 27:2",
      "Colossians 3:17",
      "Proverbs 21:5",
      "Matthew 26:41",
      "Philippians 2:3-4",
      "Psalm 141:3",
    ],
  },
  peace: {
    id: "peace",
    label: "Calm",
    emoji: "🌊",
    when: "stress, anxiety, anger, frustration, panic, overthinking, a deadline, someone pushing their buttons — the moment to stop and breathe",
    shelf: [
      "Philippians 4:6-7",
      "Isaiah 26:3",
      "John 14:27",
      "Psalm 46:10",
      "1 Peter 5:7",
      "Matthew 6:34",
      "Psalm 55:22",
      "Proverbs 15:1",
      "Ephesians 4:26",
      "Psalm 4:8",
      "Psalm 94:19",
      "Exodus 14:14",
      "Psalm 62:1-2",
      "Colossians 3:15",
      "Psalm 23:1-3",
    ],
  },
  work: {
    id: "work",
    label: "Work and provision",
    emoji: "💼",
    when: "job applications, interviews, career moves, a client, money worries, a big piece of work, a launch",
    shelf: [
      "Proverbs 16:3",
      "Psalm 90:17",
      "Colossians 3:23-24",
      "Philippians 4:19",
      "Proverbs 22:29",
      "Deuteronomy 8:18",
      "Psalm 37:5",
      "Ecclesiastes 9:10",
      "Proverbs 3:9-10",
      "Matthew 6:31-33",
      "Psalm 127:1-2",
      "Isaiah 48:17",
      "Proverbs 12:24",
      "1 Corinthians 16:13-14",
      "Genesis 39:2-3",
    ],
  },
  guidance: {
    id: "guidance",
    label: "Wisdom and direction",
    emoji: "🗺️",
    when: "a decision, uncertainty about direction, choosing between options, needing wisdom",
    shelf: [
      "James 1:5",
      "Proverbs 3:5-6",
      "Psalm 32:8",
      "Isaiah 30:21",
      "Proverbs 16:9",
      "Psalm 25:4-5",
      "Proverbs 2:6",
      "Psalm 37:23-24",
      "Isaiah 58:11",
      "Proverbs 11:14",
      "Jeremiah 33:3",
      "Psalm 143:10",
      "Proverbs 19:21",
    ],
  },
};

export const NEED_IDS = Object.keys(NEEDS) as NeedId[];

const NEED_WORDS: Record<string, NeedId> = {
  thanks: "thanksgiving", thanksgiving: "thanksgiving", gratitude: "thanksgiving", grateful: "thanksgiving", praise: "thanksgiving", morning: "thanksgiving",
  affirmation: "affirmation", identity: "affirmation", worth: "affirmation", confidence: "affirmation",
  walk: "walk", righteousness: "walk", relationship: "walk", repentance: "walk", devotion: "walk",
  faith: "faith", trust: "faith", believe: "faith", doubt: "faith",
  perseverance: "perseverance", strength: "perseverance", "keep going": "perseverance", endurance: "perseverance", motivation: "perseverance", courage: "perseverance",
  joy: "joy", smile: "joy", happy: "joy", happiness: "joy", sad: "joy",
  check: "check", correction: "check", "keep me in check": "check", discipline: "check", humility: "check", integrity: "check", temptation: "check",
  peace: "peace", calm: "peace", anxiety: "peace", anger: "peace", stress: "peace", rest: "peace",
  work: "work", job: "work", career: "work", provision: "work", money: "work", interview: "work", business: "work",
  guidance: "guidance", wisdom: "guidance", direction: "guidance", decision: "guidance",
};

/** "calm", "keep me in check", "job", "Faith" → a NeedId; null when it is not one. */
export function resolveNeed(raw: unknown): NeedId | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  if ((NEED_IDS as string[]).includes(s)) return s as NeedId;
  return NEED_WORDS[s] ?? null;
}

/** The chooser's menu: one line per need. */
export function describeNeeds(): string {
  return NEED_IDS.map((id) => `- ${id}: ${NEEDS[id].label} — ${NEEDS[id].when}`).join("\n");
}
