import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

const slideV = v.object({ index: v.number(), text: v.string(), storageId: v.optional(v.id("_storage")) });

/** Claim a URL. Returns the existing row when it was already saved. */
export const begin = internalMutation({
  args: { userId: v.id("users"), platform: v.string(), url: v.string(), userNote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("savedItems")
      .withIndex("by_user_url", (q) => q.eq("userId", args.userId).eq("url", args.url))
      .unique();
    if (existing) {
      // A re-send un-hides it and keeps the newer note.
      if (existing.hidden || (args.userNote && args.userNote !== existing.userNote)) {
        await ctx.db.patch(existing._id, {
          hidden: false,
          ...(args.userNote ? { userNote: args.userNote } : {}),
        });
      }
      return { itemId: existing._id, existing: true, status: existing.status };
    }
    const itemId = await ctx.db.insert("savedItems", {
      userId: args.userId,
      platform: args.platform,
      url: args.url,
      ...(args.userNote ? { userNote: args.userNote } : {}),
      slides: [],
      tags: [],
      status: "fetching",
      searchText: args.url,
      savedAt: Date.now(),
    });
    return { itemId, existing: false, status: "fetching" };
  },
});

export const complete = internalMutation({
  args: {
    itemId: v.id("savedItems"),
    status: v.string(),
    provider: v.optional(v.string()),
    note: v.optional(v.string()),
    author: v.optional(v.string()),
    caption: v.optional(v.string()),
    slides: v.array(slideV),
    videoTranscript: v.optional(v.string()),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    kind: v.optional(v.string()),
    tags: v.array(v.string()),
    searchText: v.string(),
    embedding: v.optional(v.array(v.float64())),
    entities: v.array(
      v.object({ type: v.string(), name: v.string(), detail: v.optional(v.string()), url: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("saved item vanished");
    const { itemId, entities, ...fields } = args;
    await ctx.db.patch(itemId, fields);

    // Replace entities, keeping the status of ones already added to a list.
    const old = await ctx.db.query("savedEntities").withIndex("by_item", (q) => q.eq("itemId", itemId)).take(200);
    const kept = new Map(old.map((e) => [`${e.type}:${e.name.toLowerCase()}`, e]));
    for (const e of old) {
      if (!entities.some((n) => `${n.type}:${n.name.toLowerCase()}` === `${e.type}:${e.name.toLowerCase()}`)) {
        await ctx.db.delete(e._id);
      }
    }
    for (const e of entities) {
      const prev = kept.get(`${e.type}:${e.name.toLowerCase()}`);
      if (prev) await ctx.db.patch(prev._id, { detail: e.detail, url: e.url });
      else await ctx.db.insert("savedEntities", { userId: item.userId, itemId, ...e, status: "saved" });
    }
  },
});

export const fail = internalMutation({
  args: { itemId: v.id("savedItems"), note: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, { status: "failed", note: args.note.slice(0, 500) });
  },
});

export const get = internalQuery({
  args: { itemId: v.id("savedItems") },
  handler: async (ctx, args) => await ctx.db.get(args.itemId),
});

export const getMany = internalQuery({
  args: { ids: v.array(v.id("savedItems")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids.slice(0, 50)) {
      const row = await ctx.db.get(id);
      if (row && !row.hidden) out.push(row);
    }
    return out;
  },
});

export const entitiesFor = internalQuery({
  args: { itemId: v.id("savedItems") },
  handler: async (ctx, args) =>
    await ctx.db.query("savedEntities").withIndex("by_item", (q) => q.eq("itemId", args.itemId)).take(200),
});

export const entitiesByType = internalQuery({
  args: { userId: v.id("users"), type: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db
      .query("savedEntities")
      .withIndex("by_user_type", (q) => q.eq("userId", args.userId).eq("type", args.type))
      .order("desc")
      .take(args.limit ?? 100),
});

/** The entities of the saved post at this URL, if it was saved. */
export const entitiesForUrl = internalQuery({
  args: { userId: v.id("users"), url: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("savedItems")
      .withIndex("by_user_url", (q) => q.eq("userId", args.userId).eq("url", args.url))
      .first();
    if (!item) return [];
    return await ctx.db
      .query("savedEntities")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .take(100);
  },
});

export const textSearch = internalQuery({
  args: { userId: v.id("users"), query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("savedItems")
      .withSearchIndex("search_text", (q) => q.search("searchText", args.query).eq("userId", args.userId))
      .take(args.limit ?? 10);
    return items.filter((i) => !i.hidden).map((i) => i._id);
  },
});

export const recent = internalQuery({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("savedItems")
      .withIndex("by_user_saved", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit ?? 10);
    return rows.filter((r) => !r.hidden);
  },
});

export const hasAny = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    (await ctx.db.query("savedItems").withIndex("by_user_saved", (q) => q.eq("userId", args.userId)).first()) !== null,
});

export const markEntities = internalMutation({
  args: {
    ids: v.array(v.id("savedEntities")),
    status: v.string(),
    list: v.optional(v.string()),
    notionPageIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    for (const [i, id] of args.ids.entries()) {
      await ctx.db.patch(id, {
        status: args.status,
        ...(args.list ? { list: args.list } : {}),
        ...(args.notionPageIds?.[i] ? { notionPageId: args.notionPageIds[i] } : {}),
      });
    }
  },
});

/** Soft delete: reversible by sending the link again. */
export const hide = internalMutation({
  args: { userId: v.id("users"), itemId: v.id("savedItems") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item || item.userId !== args.userId) return { hidden: false };
    await ctx.db.patch(args.itemId, { hidden: true });
    return { hidden: true, title: item.title };
  },
});

export const surfaced = internalMutation({
  args: { itemId: v.id("savedItems"), feedback: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return;
    await ctx.db.patch(args.itemId, {
      lastSurfacedAt: Date.now(),
      ...(args.feedback === "down" ? { downvotes: (item.downvotes ?? 0) + 1 } : {}),
    });
  },
});

/** Check-and-claim a nudge key, so a signal is considered once. */
export const claimKey = internalMutation({
  args: { userId: v.id("users"), key: v.string(), itemId: v.optional(v.id("savedItems")) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("savedNudges")
      .withIndex("by_user_key", (q) => q.eq("userId", args.userId).eq("key", args.key))
      .unique();
    if (existing) return false;
    await ctx.db.insert("savedNudges", { ...args, at: Date.now() });
    return true;
  },
});

export const nudgesSince = internalQuery({
  args: { userId: v.id("users"), sinceMs: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("savedNudges")
      .withIndex("by_user_at", (q) => q.eq("userId", args.userId).gt("at", args.sinceMs))
      .take(100);
    return rows.filter((r) => r.key.startsWith("sent:")).length;
  },
});
