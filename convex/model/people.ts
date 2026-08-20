import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Matched by display name within a user. `by_email` exists for Phase 4, where
 * an inbound address has to find its person; it is an array index, so it
 * matches any element.
 */
export const upsert = internalMutation({
  args: {
    userId: v.id("users"),
    displayName: v.string(),
    emails: v.optional(v.array(v.string())),
    importance: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(200);

    const existing = candidates.find(
      (p) => p.displayName.toLowerCase() === args.displayName.toLowerCase(),
    );

    if (existing) {
      const merged = args.emails
        ? [...new Set([...existing.emails, ...args.emails])]
        : existing.emails;

      await ctx.db.patch("people", existing._id, {
        emails: merged,
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      });
      return { personId: existing._id, created: false };
    }

    const personId = await ctx.db.insert("people", {
      userId: args.userId,
      displayName: args.displayName,
      emails: args.emails ?? [],
      importance: args.importance ?? "NORMAL",
      notes: args.notes,
    });
    return { personId, created: true };
  },
});
