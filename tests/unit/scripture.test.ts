import { describe, expect, test } from "bun:test";
import { BOOKS, normalizeBookName, resolveBook } from "../../convex/lib/scripture/books";
import {
  MAX_PASSAGE_VERSES,
  formatReference,
  overlaps,
  parseReference,
} from "../../convex/lib/scripture/reference";
import { cleanVerseText, csvRows, parseBibleFile, BibleParseError } from "../../convex/lib/scripture/parse";
import { NEEDS, NEED_IDS, resolveNeed } from "../../convex/lib/scripture/needs";
import { detectMoment } from "../../convex/lib/scripture/moment";
import {
  DEFAULT_SETTINGS,
  MAX_PER_DAY,
  decideMoment,
  decideScripture,
  describeSettings,
  settingsFrom,
  type SentToday,
} from "../../convex/lib/scripture/schedule";
import {
  CHOOSE_SYSTEM,
  PRAYER_SYSTEM,
  anchorInPassage,
  checkPrayer,
  parseChoice,
  parsePrayer,
  passageText,
  renderChooseInput,
  renderDevotional,
  type PrayerDraft,
} from "../../convex/lib/scripture/devotional";
import { TOOL_META, TOOL_SCHEMAS } from "../../convex/lib/tools/catalog";
import { TASKS } from "../../convex/lib/ai/tiers";

const TZ = "Africa/Lagos";
/** 2026-10-19 at hh:mm Lagos time (UTC+1). */
const lagos = (hh: number, mm = 0) => Date.UTC(2026, 9, 19, hh - 1, mm);

describe("books", () => {
  test("66 books, numbered in order", () => {
    expect(BOOKS).toHaveLength(66);
    BOOKS.forEach((b, i) => expect(b.n).toBe(i + 1));
  });

  test("no alias points at two books", () => {
    const seen = new Map<string, number>();
    for (const b of BOOKS) {
      for (const name of [b.name, ...b.aliases]) {
        const key = normalizeBookName(name);
        expect(seen.get(key) ?? b.n).toBe(b.n);
        seen.set(key, b.n);
      }
    }
  });

  test("the spellings real files use", () => {
    expect(resolveBook("I Samuel")).toBe(9);
    expect(resolveBook("II Kings")).toBe(12);
    expect(resolveBook("III John")).toBe(64);
    expect(resolveBook("Revelation of John")).toBe(66);
    expect(resolveBook("Psalms")).toBe(19);
    expect(resolveBook("1Cor")).toBe(46);
    expect(resolveBook("Song of Songs")).toBe(22);
    expect(resolveBook("First Thessalonians")).toBe(52);
    expect(resolveBook("The Gospel According to St. Matthew")).toBe(40);
    expect(resolveBook("Phlm")).toBe(57);
    expect(resolveBook("Isaiah")).toBe(23);
    expect(resolveBook("Tobit")).toBeNull();
  });
});

describe("references", () => {
  test("single verses, ranges, abbreviations", () => {
    expect(parseReference("Psalm 23:1")).toEqual({ book: 19, chapter: 23, verseStart: 1, verseEnd: 1 });
    expect(parseReference("1 Cor 13:4-7")).toEqual({ book: 46, chapter: 13, verseStart: 4, verseEnd: 7 });
    expect(parseReference("Isaiah 41:10–13")).toEqual({ book: 23, chapter: 41, verseStart: 10, verseEnd: 13 });
    expect(parseReference("Rom. 8:28")).toEqual({ book: 45, chapter: 8, verseStart: 28, verseEnd: 28 });
    expect(parseReference("II Timothy 1:7")?.book).toBe(55);
    expect(parseReference("Song of Solomon 2:4")?.book).toBe(22);
  });

  test("a range across chapters keeps the first verse; long ranges are capped", () => {
    expect(parseReference("John 3:16-4:2")).toEqual({ book: 43, chapter: 3, verseStart: 16, verseEnd: 16 });
    const long = parseReference("Psalm 119:1-40")!;
    expect(long.verseEnd - long.verseStart + 1).toBe(MAX_PASSAGE_VERSES);
  });

  test("not a reference", () => {
    expect(parseReference("Psalm 23")).toBeNull();
    expect(parseReference("Hezekiah 3:16")).toBeNull();
    expect(parseReference("the Lord is my shepherd")).toBeNull();
  });

  test("formatted the way a printed Bible writes it", () => {
    expect(formatReference(parseReference("phil 4:6-7")!)).toBe("Philippians 4:6–7");
    expect(formatReference(parseReference("ps 118:24")!)).toBe("Psalm 118:24");
  });

  test("overlap", () => {
    expect(overlaps(parseReference("Psalm 23:1")!, parseReference("Psalm 23:1-3")!)).toBe(true);
    expect(overlaps(parseReference("Psalm 23:4")!, parseReference("Psalm 23:1-3")!)).toBe(false);
  });
});

describe("Bible files", () => {
  test("scrollmapper JSON", () => {
    const file = JSON.stringify({
      translation: "KJV: King James Version",
      books: [
        { name: "Genesis", chapters: [{ chapter: 1, verses: [{ verse: 1, text: "In the beginning God created the heaven and the earth." }] }] },
        { name: "I John", chapters: [{ chapter: 2, verses: [{ verse: 23, text: "Whosoever denieth the Son, the same hath not the Father: [but] he that acknowledgeth the Son hath the Father also." }] }] },
      ],
    });
    const bible = parseBibleFile(file);
    expect(bible.format).toBe("scrollmapper");
    expect(bible.name).toBe("KJV: King James Version");
    expect(bible.verses[1]).toEqual({
      book: 62,
      chapter: 2,
      verse: 23,
      text: "Whosoever denieth the Son, the same hath not the Father: but he that acknowledgeth the Son hath the Father also.",
    });
  });

  test("thiagobodruk JSON: books by position, with a BOM", () => {
    const books = Array.from({ length: 19 }, (_, i) => ({ abbrev: `b${i}`, chapters: [["first"]] }));
    books[18] = { abbrev: "sl", chapters: Array.from({ length: 23 }, () => ["The LORD is my shepherd; I shall not want."]) };
    const bible = parseBibleFile(`﻿${JSON.stringify(books)}`);
    expect(bible.format).toBe("thiagobodruk");
    expect(bible.verses.find((v) => v.book === 19 && v.chapter === 23)?.text).toBe("The LORD is my shepherd; I shall not want.");
  });

  test("flat JSON rows with whatever key names", () => {
    const bible = parseBibleFile(JSON.stringify([{ book_name: "John", chapter: 3, verse: 16, text: "For God so loved the world" }]));
    expect(bible.format).toBe("flat-json");
    expect(bible.verses[0]).toMatchObject({ book: 43, chapter: 3, verse: 16 });
  });

  test("Beblia XML", () => {
    const bible = parseBibleFile(`<?xml version="1.0"?>
<bible translation="English KJV" status="Public Domain">
  <testament name="Old">
    <book number="19"><chapter number="23">
      <verse number="1">The LORD is my shepherd; I shall not want.</verse>
      <verse number="2">He maketh me to lie down in green pastures: he leadeth me beside the still waters.</verse>
    </chapter></book>
  </testament>
</bible>`);
    expect(bible.format).toBe("beblia-xml");
    expect(bible.name).toBe("English KJV");
    expect(bible.verses).toHaveLength(2);
    expect(bible.verses[1]).toMatchObject({ book: 19, chapter: 23, verse: 2 });
  });

  test("Zefania XML: Strong's markup and notes stripped", () => {
    const bible = parseBibleFile(`<XMLBIBLE biblename="World English Bible">
<BIBLEBOOK bnumber="43" bname="John"><CHAPTER cnumber="3">
<VERS vnumber="16">For God so <gr str="25">loved</gr> the world<NOTE type="x-studynote">Or, only begotten</NOTE>, that he gave his one and only Son &amp; …</VERS>
</CHAPTER></BIBLEBOOK></XMLBIBLE>`);
    expect(bible.format).toBe("zefania-xml");
    expect(bible.name).toBe("World English Bible");
    expect(bible.verses[0]).toEqual({ book: 43, chapter: 3, verse: 16, text: "For God so loved the world, that he gave his one and only Son & …" });
  });

  test("OSIS XML, container and milestone verses", () => {
    const container = parseBibleFile(`<osis><osisText><div type="book" osisID="Phil"><chapter osisID="Phil.4">
<verse osisID="Phil.4.13">I can do all things through Christ which strengtheneth me.</verse></chapter></div></osisText></osis>`);
    expect(container.format).toBe("osis-xml");
    expect(container.verses[0]).toMatchObject({ book: 50, chapter: 4, verse: 13 });

    const milestone = parseBibleFile(`<osis><osisText><chapter osisID="Ps.46">
<verse osisID="Ps.46.10" sID="Ps.46.10"/>Be still, and know that I <w lemma="x">am</w> God.<verse eID="Ps.46.10"/>
</chapter></osisText></osis>`);
    expect(milestone.verses[0]).toEqual({ book: 19, chapter: 46, verse: 10, text: "Be still, and know that I am God." });
  });

  test("CSV with quoted commas", () => {
    const bible = parseBibleFile(`Book,Chapter,Verse,Text\nProverbs,3,5,"Trust in the LORD with all thine heart; and lean not unto thine own understanding."\n"I Samuel",1,1,"Now there was a certain man, of Ramathaimzophim"`);
    expect(bible.format).toBe("csv");
    expect(bible.verses[1]).toMatchObject({ book: 9, chapter: 1, verse: 1, text: "Now there was a certain man, of Ramathaimzophim" });
    expect(csvRows('a,"b ""q"", c"\n')).toEqual([["a", 'b "q", c']]);
  });

  test("Apocrypha, empty and repeated verses are skipped, not fatal", () => {
    const bible = parseBibleFile(JSON.stringify([
      { book: "Tobit", chapter: 1, verse: 1, text: "x" },
      { book: 1, chapter: 1, verse: 1, text: "In the beginning" },
      { book: 1, chapter: 1, verse: 1, text: "duplicate" },
      { book: 1, chapter: 1, verse: 2, text: "   " },
    ]));
    expect(bible.verses).toHaveLength(1);
    expect(bible.skipped).toBe(3);
  });

  test("a file with no verses is an error, not an empty Bible", () => {
    expect(() => parseBibleFile("{}")).toThrow(BibleParseError);
    expect(() => parseBibleFile("name,age\nbob,3")).toThrow(BibleParseError);
  });

  test("cleanup keeps words, drops markup", () => {
    expect(cleanVerseText("¶ And God said , Let there be light{H216}")).toBe("And God said, Let there be light");
  });
});

describe("needs", () => {
  test("every need the owner asked for exists", () => {
    for (const id of ["thanksgiving", "affirmation", "walk", "faith", "perseverance", "joy", "check", "peace", "work"]) {
      expect(NEED_IDS).toContain(id as never);
    }
  });

  test("every shelf reference parses, and no shelf repeats itself", () => {
    for (const id of NEED_IDS) {
      const shelf = NEEDS[id].shelf;
      expect(shelf.length).toBeGreaterThanOrEqual(10);
      expect(new Set(shelf).size).toBe(shelf.length);
      for (const ref of shelf) expect(parseReference(ref)).not.toBeNull();
    }
  });

  test("the morning shelf is mostly Psalms", () => {
    const psalms = NEEDS.thanksgiving.shelf.filter((r) => parseReference(r)!.book === 19);
    expect(psalms.length / NEEDS.thanksgiving.shelf.length).toBeGreaterThan(0.6);
  });

  test("the user's words for a need", () => {
    expect(resolveNeed("calm")).toBe("peace");
    expect(resolveNeed("keep me in check")).toBe("check");
    expect(resolveNeed("JOB")).toBe("work");
    expect(resolveNeed("Faith")).toBe("faith");
    expect(resolveNeed("keep-going")).toBe("perseverance");
    expect(resolveNeed("pizza")).toBeNull();
  });
});

describe("moments", () => {
  test.each([
    ["I'm so stressed about this deadline", "peace"],
    ["honestly I need to calm down before I reply to him", "peace"],
    ["I'm applying for a job at Paystack today", "work"],
    ["got an interview at 3pm", "work"],
    ["I want to give up on this project", "perseverance"],
    ["I'm so tired of this", "perseverance"],
    ["I'm tempted to just lie to the client", "check"],
    ["been procrastinating all morning", "check"],
    ["got rejected again", "affirmation"],
    ["feeling down today", "joy"],
    ["I'm worried it won't work out", "faith"],
    ["torn between the two offers", "guidance"],
    ["I haven't prayed in days", "walk"],
    ["I got the job!!!", "thanksgiving"],
  ])("%s → %s", (text, need) => {
    expect(detectMoment(text)?.need).toBe(need as never);
  });

  test.each([
    "should I reply to this email?",
    "move THE-89 to done",
    "what's on my calendar tomorrow",
    "the client wants the invoice",
    "remind me to call mum",
    "/verse calm",
  ])("no moment: %s", (text) => {
    expect(detectMoment(text)).toBeNull();
  });
});

describe("when verses go out", () => {
  const base = { settings: DEFAULT_SETTINGS, timezone: TZ, today: [] as SentToday[] };

  test("morning verse at 06:30, thanksgiving, once", () => {
    const d = decideScripture({ ...base, nowMs: lagos(6, 30) });
    expect(d).toEqual({ send: true, trigger: "morning", key: "scripture:morning:2026-10-19", need: "thanksgiving" });
    const after = decideScripture({ ...base, nowMs: lagos(7), today: [{ trigger: "morning", sentAt: lagos(6, 30) }] });
    expect(after.send).toBe(false);
  });

  test("the morning verse is not held back by an active chat", () => {
    expect(decideScripture({ ...base, nowMs: lagos(6, 30), lastInboundMs: lagos(6, 29) }).send).toBe(true);
  });

  test("nothing before 06:30 or after the window", () => {
    expect(decideScripture({ ...base, nowMs: lagos(6, 0) })).toEqual({ send: false, reason: "outside_hours" });
    expect(decideScripture({ ...base, nowMs: lagos(22, 0), today: [{ trigger: "morning", sentAt: lagos(6, 30) }] }).send).toBe(false);
  });

  test("every couple of hours through the day", () => {
    const morning: SentToday = { trigger: "morning", sentAt: lagos(6, 30) };
    expect(decideScripture({ ...base, nowMs: lagos(9, 30), today: [morning] })).toEqual({ send: false, reason: "too_soon" });
    const first = decideScripture({ ...base, nowMs: lagos(11, 0), today: [morning] });
    expect(first.send && first.trigger).toBe("interval");
    const soon = decideScripture({ ...base, nowMs: lagos(12, 0), today: [morning, { trigger: "interval", sentAt: lagos(11) }] });
    expect(soon).toEqual({ send: false, reason: "too_soon" });
    const next = decideScripture({ ...base, nowMs: lagos(14, 30), today: [morning, { trigger: "interval", sentAt: lagos(11) }] });
    expect(next.send).toBe(true);
  });

  test("waits while they are mid-conversation and away from a check-in", () => {
    const today: SentToday[] = [{ trigger: "morning", sentAt: lagos(6, 30) }];
    expect(decideScripture({ ...base, nowMs: lagos(12), today, lastInboundMs: lagos(11, 55) })).toEqual({ send: false, reason: "user_active" });
    expect(decideScripture({ ...base, nowMs: lagos(12), today, lastCheckinMs: lagos(11, 50) })).toEqual({ send: false, reason: "near_checkin" });
  });

  test("off and the daily cap", () => {
    expect(decideScripture({ ...base, settings: { ...DEFAULT_SETTINGS, enabled: false }, nowMs: lagos(6, 30) })).toEqual({ send: false, reason: "off" });
    const full = Array.from({ length: MAX_PER_DAY }, (_, i) => ({ trigger: "interval" as const, sentAt: lagos(6) + i }));
    expect(decideScripture({ ...base, nowMs: lagos(20), today: full })).toEqual({ send: false, reason: "daily_cap" });
  });

  test("moments: cooldown and cap", () => {
    expect(decideMoment({ ...base, nowMs: lagos(12) }).send).toBe(true);
    expect(decideMoment({ ...base, nowMs: lagos(12), today: [{ trigger: "asked", sentAt: lagos(11, 40) }] })).toEqual({ send: false, reason: "cooldown" });
    const four = [8, 10, 12, 14].map((h) => ({ trigger: "moment" as const, sentAt: lagos(h) }));
    expect(decideMoment({ ...base, nowMs: lagos(16), today: four })).toEqual({ send: false, reason: "moment_cap" });
  });

  test("stored settings are read field by field", () => {
    expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ enabled: false, translation: "niv", morning: "25:00", gapMinutes: 5 })).toEqual({
      ...DEFAULT_SETTINGS,
      enabled: false,
      translation: "NIV",
    });
  });

  test("settings text says how to import when nothing is", () => {
    expect(describeSettings(DEFAULT_SETTINGS, [], 0)).toContain("scripts/import-bible.ts");
    expect(describeSettings(DEFAULT_SETTINGS, [{ code: "KJV", name: "King James Version", verseCount: 31102 }], 2)).toContain("Reading from KJV");
  });
});

describe("choosing a passage", () => {
  test("the model only names references; bad ones are dropped", () => {
    const c = parseChoice(
      '```json\n{"need": "work", "situation": "You are applying to Paystack today.", "references": ["Proverbs 16:3", "Hezekiah 1:1", "Psalm 90:17"], "searchWords": ["work", "hands"]}\n```',
      "faith",
    );
    expect(c.need).toBe("work");
    expect(c.passages.map(formatReference)).toEqual(["Proverbs 16:3", "Psalm 90:17"]);
    expect(c.searchWords).toEqual(["work", "hands"]);
  });

  test("garbage falls back to the given need with nothing proposed", () => {
    expect(parseChoice("I think Psalm 23", "thanksgiving")).toEqual({ need: "thanksgiving", situation: "", passages: [], searchWords: [] });
  });

  test("the prompt shows every need, the shelf, and the morning rule", () => {
    for (const id of NEED_IDS) expect(CHOOSE_SYSTEM).toContain(`${id}:`);
    expect(CHOOSE_SYSTEM).toContain("mostly from\n  Psalms");
    expect(CHOOSE_SYSTEM).toContain("Psalm 118:24");
    const input = renderChooseInput({ trigger: "morning", nowLabel: "Mon 19 Oct, 06:30", firstName: "Adedotun", need: "thanksgiving", about: "", recentlySent: ["Psalm 5:3"] });
    expect(input).toContain("NEED (use this one): thanksgiving");
    expect(input).toContain("- Psalm 5:3");
  });
});

describe("praying the passage", () => {
  const PASSAGE = "Commit thy works unto the LORD, and thy thoughts shall be established.";
  const good: PrayerDraft = {
    reflection: "Solomon tells you to hand the work itself to God — the application is yours to do, the outcome is His to establish.",
    points: [
      { anchor: "Commit thy works unto the LORD", prayer: "Lord, I hand You this application before I send it: every line of the cover letter is Yours." },
      { anchor: "thy thoughts shall be established", prayer: "Settle my racing thoughts about whether they will reply; establish them on what You have said, not on silence." },
    ],
    prayer: "Father, I commit this application to You. Steady my mind while I wait, and let whatever comes find me trusting You. In Jesus' name, Amen.",
  };

  test("anchors must come from the passage", () => {
    expect(anchorInPassage("Commit thy works unto the LORD", PASSAGE)).toBe(true);
    expect(anchorInPassage("commit your works unto the Lord", PASSAGE)).toBe(true); // one word modernised
    expect(anchorInPassage("the Lord will give you the job", PASSAGE)).toBe(false);
    expect(anchorInPassage("LORD", PASSAGE)).toBe(false); // too short to anchor anything
  });

  test("a sound draft passes untouched", () => {
    const r = checkPrayer(PASSAGE, good, 2);
    expect(r.ok).toBe(true);
    expect(r.draft.points).toHaveLength(2);
    expect(r.problems).toEqual([]);
  });

  test("invented, repeated and filler points are removed with reasons", () => {
    const r = checkPrayer(
      PASSAGE,
      {
        ...good,
        points: [
          good.points[0]!,
          { anchor: "Commit thy works unto the LORD", prayer: "Again, I commit my works to You today, Lord, every one." },
          { anchor: "you will surely get the job", prayer: "Lord, give me this job because You promised it to me." },
          { anchor: "thy thoughts shall be established", prayer: "Bless me." },
        ],
      },
      2,
    );
    expect(r.ok).toBe(false);
    expect(r.draft.points).toHaveLength(1);
    expect(r.problems.join("\n")).toContain("used twice");
    expect(r.problems.join("\n")).toContain("not in the passage");
    expect(r.problems.join("\n")).toContain("too thin");
  });

  test("parse is lenient about fences and drops malformed points", () => {
    const d = parsePrayer('```json\n{"reflection":"r","points":[{"anchor":"a b"},{"anchor":"x y","prayer":"p"}],"prayer":"q"}\n```');
    expect(d?.points).toEqual([{ anchor: "x y", prayer: "p" }]);
    expect(parsePrayer("no json here")).toBeNull();
  });

  test("the prayer prompt forbids promises the verse does not make", () => {
    expect(PRAYER_SYSTEM).toContain("do not promise");
    expect(PRAYER_SYSTEM).toContain("COPIED EXACTLY");
  });
});

describe("the message", () => {
  const passage = parseReference("Psalm 118:24")!;
  const verses = [{ verse: 24, text: "This is the day which the LORD hath made; we will rejoice and be glad in it." }];

  test("morning: greeting, reference, verse quoted, prayer points", () => {
    const text = renderDevotional({
      trigger: "morning",
      need: "thanksgiving",
      firstName: "Adedotun",
      passage,
      translation: "KJV",
      verses,
      draft: {
        reflection: "The psalmist calls a day God made a reason to rejoice.",
        points: [{ anchor: "the day which the LORD hath made", prayer: "Thank You that today is Yours before it is mine." }],
        prayer: "Father, I receive today as Your gift and I will be glad in it. In Jesus' name, Amen.",
      },
    });
    expect(text.split("\n")[0]).toBe("🌅 **Good morning, Adedotun.**");
    expect(text).toContain("**Psalm 118:24** (KJV)");
    expect(text).toContain("> This is the day");
    expect(text).toContain('- "the day which the LORD hath made" — Thank You');
    expect(text).toContain("🙏 Father,");
  });

  test("without a checked prayer the verse still goes, with no invented prayer", () => {
    const text = renderDevotional({ trigger: "moment", need: "peace", firstName: "A", passage, translation: "KJV", verses, draft: null });
    expect(text.startsWith("🌊 **Calm**")).toBe(true);
    expect(text).not.toContain("Pray it");
  });

  test("several verses get superscript numbers", () => {
    expect(passageText([{ verse: 6, text: "Be careful for nothing;" }, { verse: 7, text: "And the peace of God" }])).toBe(
      "⁶ Be careful for nothing; ⁷ And the peace of God",
    );
  });
});

describe("wiring", () => {
  test("tools and tasks exist", () => {
    expect(TOOL_SCHEMAS["scripture.send"]).toBeDefined();
    expect(TOOL_META["scripture.send"].consequential).toBe(false);
    expect(TOOL_SCHEMAS["scripture.settings"].safeParse({ translation: "KJV", morning: "06:15" }).success).toBe(true);
    expect(TOOL_SCHEMAS["scripture.settings"].safeParse({ morning: "6am" }).success).toBe(false);
    expect(TASKS.CHOOSE_SCRIPTURE.tier).toBe("REASON");
    expect(TASKS.WRITE_PRAYER.tier).toBe("DRAFT");
  });
});

describe("Bible SuperSearch export (the owner's kjv.json)", () => {
  test("metadata gives the name and code; red letters and paragraph marks go", () => {
    const bible = parseBibleFile(JSON.stringify({
      metadata: { name: "Authorized King James Version", shortname: "KJV" },
      verses: [
        { book_name: "Genesis", book: 1, chapter: 1, verse: 1, text: "¶ In the beginning God created the heaven and the earth." },
        { book_name: "Revelation", book: 66, chapter: 22, verse: 20, text: "¶ He which testifieth these things saith, ‹Surely I come quickly.› Amen." },
      ],
    }));
    expect(bible.format).toBe("flat-json");
    expect(bible.name).toBe("Authorized King James Version");
    expect(bible.code).toBe("KJV");
    expect(bible.verses[0]!.text).toBe("In the beginning God created the heaven and the earth.");
    expect(bible.verses[1]!.text).toBe("He which testifieth these things saith, Surely I come quickly. Amen.");
  });
});
