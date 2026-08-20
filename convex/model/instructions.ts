import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * A hard ceiling, not a soft target. These are rendered into EVERY planning
 * prompt, so an unbounded list is an unbounded per-message cost — the same
 * failure shape as the two-call-per-message bug fixed earlier, just from a
 * different direction.
 */
export const CUSTOM_INSTRUCTIONS_MAX = 20;

export const add = internalMutation({
  args: { userId: v.id("users"), text: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("customInstructions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    if (existing.length >= CUSTOM_INSTRUCTIONS_MAX) {
      throw new Error(
        `You have ${existing.length} custom instructions, the max is ${CUSTOM_INSTRUCTIONS_MAX}. ` +
          `Remove one before adding another.`,
      );
    }

    const instructionId = await ctx.db.insert("customInstructions", {
      userId: args.userId,
      text: args.text,
    });
    return { instructionId };
  },
});

export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("customInstructions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(CUSTOM_INSTRUCTIONS_MAX);
  },
});

/** Same id-or-fragment pattern as tasks.findByTitle — the model rarely has
 *  the id handy when the user says "forget the thing about X". */
export const findByFragment = internalQuery({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("customInstructions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(CUSTOM_INSTRUCTIONS_MAX);

    const needle = args.fragment.trim().toLowerCase();
    return all.find((row) => row.text.toLowerCase().includes(needle)) ?? null;
  },
});

export const remove = internalMutation({
  args: { userId: v.id("users"), instructionId: v.id("customInstructions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("customInstructions", args.instructionId);
    if (!row || row.userId !== args.userId) return { removed: false };
    await ctx.db.delete("customInstructions", args.instructionId);
    return { removed: true };
  },
});
