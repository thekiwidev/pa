import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { MAX_PASSAGE_VERSES } from "../lib/scripture/reference";

/** More translations than anyone imports; the bound is the point. */
const MAX_TRANSLATIONS = 50;

export const listTranslations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("bibleTranslations").take(MAX_TRANSLATIONS);
  },
});

export const getTranslation = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bibleTranslations")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .first();
  },
});

/** The verses of one passage, in order. Empty when the reference is not in this Bible. */
export const getPassage = internalQuery({
  args: {
    translation: v.string(),
    book: v.number(),
    chapter: v.number(),
    verseStart: v.number(),
    verseEnd: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("bibleVerses")
      .withIndex("by_ref", (q) =>
        q
          .eq("translation", args.translation)
          .eq("book", args.book)
          .eq("chapter", args.chapter)
          .gte("verse", args.verseStart)
          .lte("verse", args.verseEnd),
      )
      .take(MAX_PASSAGE_VERSES);
    return rows.map((r) => ({ verse: r.verse, text: r.text }));
  },
});

/** Full-text search inside one translation — the chooser's fallback. */
export const search = internalQuery({
  args: { translation: v.string(), query: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("bibleVerses")
      .withSearchIndex("search_text", (q) => q.search("text", args.query).eq("translation", args.translation))
      .take(Math.min(args.limit, 20));
    return rows.map((r) => ({ book: r.book, chapter: r.chapter, verse: r.verse, text: r.text }));
  },
});

/** Called by scripts/import-bible.ts after the verses are in. */
export const upsertTranslation = internalMutation({
  args: { code: v.string(), name: v.string(), format: v.string(), verseCount: v.number() },
  handler: async (ctx, args) => {
    const code = args.code.toUpperCase();
    const existing = await ctx.db
      .query("bibleTranslations")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    const row = { code, name: args.name, format: args.format, verseCount: args.verseCount, importedAt: Date.now() };
    if (existing) {
      await ctx.db.patch("bibleTranslations", existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("bibleTranslations", row);
  },
});

/**
 * Delete up to `limit` verses of one translation. The import script calls it
 * until `more` is false, before re-importing that translation; deleting 31k
 * rows in one transaction would exceed the write limit. The translation row
 * goes with the last batch.
 */
export const deleteVersesBatch = internalMutation({
  args: { translation: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const code = args.translation.toUpperCase();
    const limit = Math.min(args.limit ?? 4000, 4000);
    const rows = await ctx.db
      .query("bibleVerses")
      .withIndex("by_ref", (q) => q.eq("translation", code))
      .take(limit);
    for (const row of rows) await ctx.db.delete("bibleVerses", row._id);
    const more = rows.length === limit;
    if (!more) {
      const translation = await ctx.db
        .query("bibleTranslations")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (translation) await ctx.db.delete("bibleTranslations", translation._id);
    }
    return { deleted: rows.length, more };
  },
});

/** Is there at least one verse stored for this code? Cheap: one indexed read. */
export const hasVerses = internalQuery({
  args: { translation: v.string() },
  handler: async (ctx, args) => {
    const one = await ctx.db
      .query("bibleVerses")
      .withIndex("by_ref", (q) => q.eq("translation", args.translation.toUpperCase()))
      .first();
    return one !== null;
  },
});

/** Sends since `sinceMs`, newest first. */
export const sendsSince = internalQuery({
  args: { userId: v.id("users"), sinceMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scriptureSends")
      .withIndex("by_user_sent", (q) => q.eq("userId", args.userId).gte("sentAt", args.sinceMs))
      .order("desc")
      .take(Math.min(args.limit ?? 60, 200));
  },
});

export const recordSend = internalMutation({
  args: {
    userId: v.id("users"),
    trigger: v.string(),
    need: v.string(),
    translation: v.string(),
    book: v.number(),
    chapter: v.number(),
    verseStart: v.number(),
    verseEnd: v.number(),
    situation: v.optional(v.string()),
    prayerOpening: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("scriptureSends", { ...args, sentAt: Date.now() });
  },
});
