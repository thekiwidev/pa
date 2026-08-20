import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { DEFAULT_SKILLS, resolveSkillReferences } from "../lib/skills";

/** Create-or-replace by name. A skill has one row per (userId, name) —
 *  updating means overwriting content, never appending. */
export const upsert = internalMutation({
  args: { userId: v.id("users"), name: v.string(), title: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId).eq("name", args.name))
      .unique();

    if (existing) {
      await ctx.db.patch("skills", existing._id, { title: args.title, content: args.content });
      return { skillId: existing._id, created: false };
    }

    const skillId = await ctx.db.insert("skills", args);
    return { skillId, created: true };
  },
});

export const remove = internalMutation({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId).eq("name", args.name))
      .unique();
    if (!existing) return { removed: false };
    await ctx.db.delete("skills", existing._id);
    return { removed: true };
  },
});

/** Every skill name known to the system (customized or still default),
 *  merged so nothing the user hasn't touched yet is invisible to /skills. */
export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("skills")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId))
      .take(50);
    const customized = new Map(rows.map((r) => [r.name, r]));

    const names = new Set([...Object.keys(DEFAULT_SKILLS), ...customized.keys()]);
    return [...names].map((name) => {
      const row = customized.get(name);
      const fallback = DEFAULT_SKILLS[name];
      return {
        name,
        title: row?.title ?? fallback?.title ?? name,
        customized: row !== undefined,
      };
    });
  },
});

/**
 * The effective content for one skill: the user's own version if they've
 * written one, else the built-in default, else nothing — with
 * {{skill:other}} references expanded against this same fallback rule, one
 * query per referenced name (skills are few and short; this is not a table
 * anything scans at volume).
 */
export const getEffective = internalQuery({
  args: { userId: v.id("users"), name: v.string() },
  handler: async (ctx, args): Promise<{ title: string; content: string } | null> => {
    const own = await ctx.db
      .query("skills")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId).eq("name", args.name))
      .unique();

    const base = own ?? DEFAULT_SKILLS[args.name];
    if (!base) return null;

    const allOwn = await ctx.db
      .query("skills")
      .withIndex("by_user_name", (q) => q.eq("userId", args.userId))
      .take(50);
    const ownByName = new Map(allOwn.map((r) => [r.name, r.content]));

    const content = resolveSkillReferences(
      base.content,
      (refName) => ownByName.get(refName) ?? DEFAULT_SKILLS[refName]?.content,
    );

    return { title: base.title, content };
  },
});
