import { internalMutation, internalQuery } from "../_generated/server";
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

/**
 * Address -> person, for the Phase 4 pre-filter.
 *
 * NOT via the `by_email` index. That index is declared on `emails`, an
 * array field, and schema.ts has claimed since Phase 0 that it "matches any
 * element" — it does not. Convex indexes the whole array VALUE, so
 * `.eq("emails", "a@b.com")` does not typecheck and
 * `.eq("emails", ["a@b.com"])` would only match a person whose address list
 * is exactly that one entry. The comment was wrong, not the code.
 *
 * So: bounded scan by user, filter in code — the same shape `upsert` above
 * already uses, and honest about being a scan. At personal volume (tens of
 * people) this is cheaper than the extra table a real element-index would
 * need. If `people` ever grows past a few hundred rows, add a normalized
 * `personEmails(userId, email, personId)` table with its own index rather
 * than raising this bound.
 */
export const getByEmail = internalQuery({
  args: { userId: v.id("users"), email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const candidates = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(200);
    return (
      candidates.find((p) => p.emails.some((e) => e.trim().toLowerCase() === email)) ?? null
    );
  },
});
