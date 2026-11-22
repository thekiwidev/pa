import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { DEFAULT_SOURCES } from "../lib/news/sources";

const MAX_SOURCES = 40;
const POOL_READ = 400;
const PURGE_BATCH = 200;

const configV = v.object({
  url: v.optional(v.string()),
  label: v.optional(v.string()),
  query: v.optional(v.string()),
  subreddit: v.optional(v.string()),
  sender: v.optional(v.string()),
});

/* ── sources ── */

export const sources = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    await ctx.db.query("newsSources").withIndex("by_user", (q) => q.eq("userId", args.userId)).take(MAX_SOURCES),
});

/** Seeds the defaults the first time. Check-then-insert inside one mutation. */
export const seedDefaults = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const any = await ctx.db.query("newsSources").withIndex("by_user", (q) => q.eq("userId", args.userId)).first();
    if (any) return 0;
    for (const spec of DEFAULT_SOURCES) {
      await ctx.db.insert("newsSources", { userId: args.userId, kind: spec.kind, config: spec.config, enabled: true, addedBy: "default" });
    }
    return DEFAULT_SOURCES.length;
  },
});

/** Sender patterns of the newsletters the owner reads here: their mail goes to the news pool, not to an alert. */
export const newsletterSenders = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("newsSources").withIndex("by_user", (q) => q.eq("userId", args.userId)).take(MAX_SOURCES);
    return rows
      .filter((r) => r.kind === "newsletter" && r.enabled && r.config.sender)
      .map((r) => r.config.sender!);
  },
});

export const addSource = internalMutation({
  args: { userId: v.id("users"), kind: v.string(), config: configV },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("newsSources").withIndex("by_user", (q) => q.eq("userId", args.userId)).take(MAX_SOURCES);
    const same = rows.find(
      (r) =>
        r.kind === args.kind &&
        (r.config.url ?? r.config.sender ?? r.config.subreddit ?? r.config.query ?? "") ===
          (args.config.url ?? args.config.sender ?? args.config.subreddit ?? args.config.query ?? ""),
    );
    if (same) {
      if (!same.enabled) await ctx.db.patch("newsSources", same._id, { enabled: true });
      return { created: false };
    }
    if (rows.length >= MAX_SOURCES) throw new Error(`you already watch ${MAX_SOURCES} sources; remove one first`);
    await ctx.db.insert("newsSources", { userId: args.userId, kind: args.kind, config: args.config, enabled: true, addedBy: "owner" });
    return { created: true };
  },
});

/** Remove by a fragment of the name, url, sender or kind. Returns what went. */
export const removeSource = internalMutation({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const needle = args.fragment.trim().toLowerCase();
    if (!needle) return [];
    const rows = await ctx.db.query("newsSources").withIndex("by_user", (q) => q.eq("userId", args.userId)).take(MAX_SOURCES);
    const hits = rows.filter((r) =>
      [r.kind, r.config.label, r.config.url, r.config.sender, r.config.subreddit].some((f) => f?.toLowerCase().includes(needle)),
    );
    for (const r of hits) await ctx.db.delete("newsSources", r._id);
    return hits.map((r) => r.config.label ?? r.config.url ?? r.config.sender ?? r.kind);
  },
});

/* ── items ── */

const itemV = v.object({
  urlHash: v.string(),
  url: v.string(),
  title: v.string(),
  source: v.string(),
  publishedAt: v.number(),
  score: v.number(),
  snippet: v.string(),
});

export const upsertMany = internalMutation({
  args: { userId: v.id("users"), items: v.array(itemV), nowMs: v.number() },
  handler: async (ctx, args) => {
    let inserted = 0;
    for (const item of args.items.slice(0, 200)) {
      const have = await ctx.db
        .query("newsItems")
        .withIndex("by_user_hash", (q) => q.eq("userId", args.userId).eq("urlHash", item.urlHash))
        .first();
      if (have) {
        if (item.score > have.score) await ctx.db.patch("newsItems", have._id, { score: item.score });
        continue;
      }
      await ctx.db.insert("newsItems", { userId: args.userId, ...item, fetchedAt: args.nowMs });
      inserted++;
    }
    return inserted;
  },
});

/** The pool: recent rows not yet sent. Bounded read, filtered in code. */
export const pool = internalQuery({
  args: { userId: v.id("users"), sinceMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("newsItems")
      .withIndex("by_user_fetched", (q) => q.eq("userId", args.userId).gte("fetchedAt", args.sinceMs))
      .order("desc")
      .take(POOL_READ);
    return rows.filter((r) => r.sentAt === undefined);
  },
});

/** urlHashes already sent, for dedupe against a fresh fetch. */
export const sentHashes = internalQuery({
  args: { userId: v.id("users"), sinceMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("newsItems")
      .withIndex("by_user_fetched", (q) => q.eq("userId", args.userId).gte("fetchedAt", args.sinceMs))
      .order("desc")
      .take(POOL_READ);
    return rows.filter((r) => r.sentAt !== undefined).map((r) => r.urlHash);
  },
});

export const markSent = internalMutation({
  args: { ids: v.array(v.id("newsItems")), nowMs: v.number() },
  handler: async (ctx, args) => {
    for (const id of args.ids.slice(0, 30)) {
      if (await ctx.db.get("newsItems", id)) await ctx.db.patch("newsItems", id, { sentAt: args.nowMs });
    }
  },
});

export const getItem = internalQuery({
  args: { id: v.id("newsItems") },
  handler: async (ctx, args) => await ctx.db.get("newsItems", args.id),
});

/** Looks up by hash, so the newsletter can map a ranked story back to its row. */
export const byHashes = internalQuery({
  args: { userId: v.id("users"), hashes: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out = [];
    for (const h of args.hashes.slice(0, 30)) {
      const row = await ctx.db
        .query("newsItems")
        .withIndex("by_user_hash", (q) => q.eq("userId", args.userId).eq("urlHash", h))
        .first();
      if (row) out.push(row);
    }
    return out;
  },
});

/* ── feedback ── */

export const recordFeedback = internalMutation({
  args: { userId: v.id("users"), newsItemId: v.id("newsItems"), verdict: v.string(), nowMs: v.number() },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("newsItems", args.newsItemId);
    if (!item) return null;
    await ctx.db.insert("newsFeedback", {
      userId: args.userId, newsItemId: args.newsItemId, verdict: args.verdict, createdAt: args.nowMs,
    });
    return { title: item.title };
  },
});

/* ── cleanup ── */

/** Rows older than the cutoff, a bounded batch at a time. Returns how many went. */
export const purgeOld = internalMutation({
  args: { olderThanMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("newsItems")
      .withIndex("by_fetched", (q) => q.lt("fetchedAt", args.olderThanMs))
      .take(PURGE_BATCH);
    for (const r of rows) await ctx.db.delete("newsItems", r._id);
    return rows.length;
  },
});
