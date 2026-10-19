// The scripture pipeline end to end, minus the network: convex/scripture.ts's
// real sendDevotional / updateSettings, against an in-memory stand-in for
// the Convex functions it calls, loaded with the committed KJV through the
// real parser. The model (runTask) and Telegram (sendMessage) are stubbed,
// so this proves the wiring — lookup, fallbacks, the prayer check and
// retry, what gets recorded — not the model's judgement.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { parseBibleFile } from "../../convex/lib/scripture/parse";

// bun's mock.module is process-wide: other test files import these modules
// too, so every real export is kept and only the network calls replaced.
const realRegistry = await import("../../convex/ai/registry");
const realTelegram = await import("../../convex/channels/telegram");
const realOps = await import("../../convex/ops");

type Reply = string | Error;
const modelReplies: Record<string, Reply[]> = {};
const modelCalls: { task: string; input: string; untrusted?: { label: string; content: string }[] }[] = [];
const sent: string[] = [];

mock.module("../../convex/ai/registry", () => ({
  ...realRegistry,
  runTask: async (task: string, args: { input: string; untrusted?: { label: string; content: string }[] }) => {
    modelCalls.push({ task, input: args.input, untrusted: args.untrusted });
    const next = modelReplies[task]?.shift();
    if (next === undefined) throw new Error(`no stubbed reply for ${task}`);
    if (next instanceof Error) throw next;
    return { text: next, providerId: "gemini", model: "stub" };
  },
}));
mock.module("../../convex/channels/telegram", () => ({
  ...realTelegram,
  sendMessage: async (_chatId: string, text: string) => {
    sent.push(text);
    return `m${sent.length}`;
  },
}));
mock.module("../../convex/ops", () => ({
  ...realOps,
  // A failure inside sendDevotional is caught and reported; rethrowing here
  // makes it fail the test instead of hiding behind { sent: false }.
  reportIncident: async (_ctx: unknown, args: { error: unknown }) => {
    throw args.error instanceof Error ? args.error : new Error(String(args.error));
  },
}));

const { sendDevotional, updateSettings } = await import("../../convex/scripture");

const kjv = parseBibleFile(await Bun.file("assets/bibles/KJV.json").text());
const VERSES = new Map(kjv.verses.map((v) => [`${v.book}:${v.chapter}:${v.verse}`, v.text]));

interface Send {
  book: number;
  chapter: number;
  verseStart: number;
  verseEnd: number;
  trigger: string;
  need: string;
  prayerOpening?: string;
  sentAt: number;
}

let prefs: Record<string, unknown>;
let sends: Send[];
let messages: { direction: string; kind: string; text: string; _creationTime: number }[];
let audit: { action: string; args: Record<string, unknown> }[];

const USER = { _id: "u1", telegramId: "42", displayName: "Adedotun Gabriel", timezone: "Africa/Lagos" };

const handlers: Record<string, (a: Record<string, any>) => unknown> = {
  "model/users:get": () => USER,
  "model/preferences:get": (a) => prefs[a.key] ?? null,
  "model/preferences:set": (a) => {
    prefs[a.key] = a.value;
  },
  "model/scripture:listTranslations": () => [{ code: "KJV", name: kjv.name, verseCount: kjv.verses.length }],
  "model/scripture:getPassage": (a) => {
    const out = [];
    for (let v = a.verseStart; v <= a.verseEnd; v++) {
      const text = VERSES.get(`${a.book}:${a.chapter}:${v}`);
      if (text) out.push({ verse: v, text });
    }
    return out;
  },
  "model/scripture:search": (a) => {
    const words = String(a.query).toLowerCase().split(/\s+/);
    return kjv.verses.filter((v) => words.every((w) => v.text.toLowerCase().includes(w))).slice(0, a.limit);
  },
  "model/scripture:sendsSince": (a) => sends.filter((s) => s.sentAt >= a.sinceMs).reverse(),
  "model/scripture:recordSend": (a) => {
    sends.push({ ...(a as Send), sentAt: Date.now() });
  },
  "model/userContext:list": () => [{ category: "profile", text: "Front-end engineer in Abuja, job hunting for remote roles" }],
  "model/messages:getSummary": () => ({ summary: "They have been preparing job applications all week." }),
  "model/messages:recentForUser": () => messages,
  "model/messages:record": (a) => {
    messages.push({ direction: a.direction, kind: a.kind, text: a.text, _creationTime: Date.now() });
  },
  "model/audit:record": (a) => {
    audit.push({ action: a.action, args: a.args });
  },
};

const call = async (ref: unknown, args: Record<string, unknown>) => {
  const name = getFunctionName(ref as never);
  const handler = handlers[name];
  if (!handler) throw new Error(`unhandled Convex function ${name}`);
  return handler(args);
};
const ctx = { runQuery: call, runMutation: call, runAction: call, scheduler: { runAfter: async () => null } } as never;

const goodPrayer = (anchorA: string, anchorB: string) =>
  JSON.stringify({
    reflection: "Solomon tells you to hand the work itself to God; the outcome is His to establish.",
    points: [
      { anchor: anchorA, prayer: "Lord, I hand You this application before I press send, every line of it." },
      { anchor: anchorB, prayer: "Settle my racing thoughts while I wait on a reply; establish them on You." },
    ],
    prayer: "Father, I commit this application to You and leave the answer in Your hands. In Jesus' name, Amen.",
  });

beforeEach(() => {
  prefs = {};
  sends = [];
  messages = [{ direction: "in", kind: "text", text: "I'm applying for a job at Paystack today", _creationTime: Date.now() - 60_000 }];
  audit = [];
  sent.length = 0;
  modelCalls.length = 0;
  for (const k of Object.keys(modelReplies)) delete modelReplies[k];
  process.env.USER_TIMEZONE = "Africa/Lagos";
});

describe("sendDevotional with the committed KJV", () => {
  test("job application: chosen reference, KJV text, checked prayer, recorded", async () => {
    modelReplies.CHOOSE_SCRIPTURE = [
      JSON.stringify({ need: "work", situation: "You are sending a job application to Paystack today.", references: ["Proverbs 16:3"], searchWords: ["works"] }),
    ];
    modelReplies.WRITE_PRAYER = [goodPrayer("Commit thy works unto the LORD", "thy thoughts shall be established")];

    const result = await sendDevotional(ctx, "u1" as never, { trigger: "asked", ask: "applying for a job" });

    expect(result).toEqual({ sent: true, reference: "Proverbs 16:3", need: "work", translation: "KJV", prayerChecked: true });
    expect(sent).toHaveLength(1);
    const text = sent[0]!;
    expect(text).toContain("💼 **Work and provision**");
    expect(text).toContain("**Proverbs 16:3** (KJV)");
    expect(text).toContain("> Commit thy works unto the LORD, and thy thoughts shall be established.");
    expect(text).toContain('- "Commit thy works unto the LORD" — Lord, I hand You');
    expect(text).toContain("🙏 Father, I commit");
    expect(sends[0]).toMatchObject({ book: 20, chapter: 16, verseStart: 3, verseEnd: 3, trigger: "asked", need: "work" });
    expect(messages.at(-1)).toMatchObject({ direction: "out", kind: "scripture" });
    expect(audit[0]).toMatchObject({ action: "scripture.send" });

    // The conversation reached the chooser as untrusted data, not as input.
    const choose = modelCalls.find((c) => c.task === "CHOOSE_SCRIPTURE")!;
    expect(choose.input).not.toContain("Paystack today");
    expect(choose.untrusted?.map((u) => u.label)).toEqual(["conversation-summary", "recent-conversation"]);
    expect(choose.untrusted?.[1]?.content).toContain("I'm applying for a job at Paystack today");
    // The prayer writer was handed the passage as printed in the KJV.
    expect(modelCalls.find((c) => c.task === "WRITE_PRAYER")!.input).toContain(
      "Commit thy works unto the LORD, and thy thoughts shall be established.",
    );
  });

  test("an invented anchor is rejected, the retry carries the reason, the fix is sent", async () => {
    modelReplies.CHOOSE_SCRIPTURE = [JSON.stringify({ need: "work", situation: "s", references: ["Proverbs 16:3"] })];
    modelReplies.WRITE_PRAYER = [
      goodPrayer("God will surely give you this job", "thy thoughts shall be established"),
      goodPrayer("Commit thy works unto the LORD", "thy thoughts shall be established"),
    ];
    const result = await sendDevotional(ctx, "u1" as never, { trigger: "interval" });
    expect(result).toMatchObject({ sent: true, prayerChecked: true });
    const retry = modelCalls.filter((c) => c.task === "WRITE_PRAYER")[1]!;
    expect(retry.input).toContain('anchor "God will surely give you this job" is not in the passage');
    expect(sent[0]).not.toContain("surely give you this job");
  });

  test("two failed prayers: the verse goes out alone, never an unchecked prayer", async () => {
    modelReplies.CHOOSE_SCRIPTURE = [JSON.stringify({ need: "peace", references: ["Philippians 4:6-7"] })];
    modelReplies.WRITE_PRAYER = ["not json", goodPrayer("invented words here", "more invented words")];
    const result = await sendDevotional(ctx, "u1" as never, { trigger: "moment" });
    expect(result).toMatchObject({ sent: true, reference: "Philippians 4:6–7", prayerChecked: false });
    expect(sent[0]).toContain("⁶ Be careful for nothing;");
    expect(sent[0]).toContain("⁷ And the peace of God");
    expect(sent[0]).not.toContain("Pray it");
  });

  test("a made-up or recently sent reference falls through to the shelf", async () => {
    sends.push({ book: 19, chapter: 118, verseStart: 24, verseEnd: 24, trigger: "morning", need: "thanksgiving", sentAt: Date.now() - 86_400_000 });
    modelReplies.CHOOSE_SCRIPTURE = [JSON.stringify({ need: "thanksgiving", references: ["Psalm 118:24", "Psalm 200:1"] })];
    modelReplies.WRITE_PRAYER = [new Error("quota")];
    const result = await sendDevotional(ctx, "u1" as never, { trigger: "morning", need: "thanksgiving" });
    expect(result.sent).toBe(true);
    if (!result.sent) return;
    expect(result.reference).not.toBe("Psalm 118:24");
    expect(sent[0]!.split("\n")[0]).toBe("🌅 **Good morning, Adedotun.**");
  });

  test("no model at all: still a verse from the shelf for the forced need", async () => {
    modelReplies.CHOOSE_SCRIPTURE = [new Error("all providers failed")];
    modelReplies.WRITE_PRAYER = [new Error("all providers failed")];
    const result = await sendDevotional(ctx, "u1" as never, { trigger: "moment", need: "check" });
    expect(result).toMatchObject({ sent: true, need: "check", prayerChecked: false });
    expect(sent[0]).toContain("⚖️ **Keep me in check**");
  });

  test("turned off: unprompted verses stop, an asked one still goes", async () => {
    await updateSettings(ctx, "u1" as never, { enabled: false });
    expect(await sendDevotional(ctx, "u1" as never, { trigger: "interval" })).toEqual({ sent: false, reason: "off" });
    modelReplies.CHOOSE_SCRIPTURE = [JSON.stringify({ need: "joy", references: ["Nehemiah 8:10"] })];
    modelReplies.WRITE_PRAYER = [new Error("quota")];
    expect((await sendDevotional(ctx, "u1" as never, { trigger: "asked" })).sent).toBe(true);
  });

  test("settings: unknown translation refused, known one stored", async () => {
    const bad = await updateSettings(ctx, "u1" as never, { translation: "NIV" });
    expect(bad).toMatchObject({ ok: false, available: ["KJV"] });
    const good = await updateSettings(ctx, "u1" as never, { translation: "kjv", morning: "06:15" });
    expect(good.ok).toBe(true);
    expect(prefs.scripture).toMatchObject({ translation: "KJV", morning: "06:15", enabled: true });
  });
});
