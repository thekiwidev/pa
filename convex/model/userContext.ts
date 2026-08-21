import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { MAX_CONTEXT_ENTRIES, MAX_ENTRY_CHARS } from "../lib/userContext";

export const add = internalMutation({
  args: { userId: v.id("users"), category: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim().slice(0, MAX_ENTRY_CHARS);
    if (!text) throw new Error("empty context entry");

    const existing = await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES + 1);

    // Near-duplicate guard: re-stating a fact should update, not accumulate.
    // Without this, "I'm a frontend engineer" said three times over three
    // weeks becomes three rows that all render on every message.
    const duplicate = existing.find(
      (e) => e.text.trim().toLowerCase() === text.toLowerCase(),
    );
    if (duplicate) return { contextId: duplicate._id, created: false, text };

    if (existing.length >= MAX_CONTEXT_ENTRIES) {
      throw new Error(
        `You have ${existing.length} context entries, the max is ${MAX_CONTEXT_ENTRIES}. ` +
          `Remove one before adding another.`,
      );
    }

    const contextId = await ctx.db.insert("userContext", {
      userId: args.userId,
      category: args.category,
      text,
    });
    return { contextId, created: true, text };
  },
});

export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES);
  },
});

/** Same id-or-fragment pattern as tasks.findByTitle and
 *  instructions.findByFragment — the user says "forget the React thing",
 *  not an id. */
export const findByFragment = internalQuery({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("userContext")
      .withIndex("by_user_category", (q) => q.eq("userId", args.userId))
      .take(MAX_CONTEXT_ENTRIES);

    const needle = args.fragment.trim().toLowerCase();
    return all.find((e) => e.text.toLowerCase().includes(needle)) ?? null;
  },
});

export const remove = internalMutation({
  args: { userId: v.id("users"), contextId: v.id("userContext") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("userContext", args.contextId);
    if (!row || row.userId !== args.userId) return { removed: false };
    await ctx.db.delete("userContext", args.contextId);
    return { removed: true, text: row.text };
  },
});
