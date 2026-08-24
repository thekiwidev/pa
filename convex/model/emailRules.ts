import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { normalizePattern, type EmailRule, type RuleAction } from "../lib/email/rules";

/**
 * Bounded like every other per-user list here. Forty rules is far more than
 * a single user writes, and the cap keeps the prefilter's per-message read
 * predictable — this query runs on EVERY synced message.
 */
const MAX_RULES = 40;

const ACTIONS: RuleAction[] = ["IGNORE", "NEVER_ALERT", "FLOOR_HIGH"];

export const list = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("emailRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(MAX_RULES),
});

/**
 * The rule rows as the pure matcher wants them. Kept separate from `list` so
 * the shape lib/email/rules.ts sees never depends on the document shape.
 */
export const listForMatching = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<EmailRule[]> => {
    const rows = await ctx.db
      .query("emailRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(MAX_RULES);
    return rows.map((r) => ({
      senderPattern: r.senderPattern,
      subjectPattern: r.subjectPattern,
      category: r.category,
      accountLabel: r.accountLabel,
      action: r.action as RuleAction,
      reason: r.reason,
    }));
  },
});

export const add = internalMutation({
  args: {
    userId: v.id("users"),
    senderPattern: v.optional(v.string()),
    subjectPattern: v.optional(v.string()),
    category: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    action: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!ACTIONS.includes(args.action as RuleAction)) {
      throw new Error(`unknown rule action "${args.action}"`);
    }

    // A rule with no conditions would match every message. The pure matcher
    // refuses one too, but refusing at the WRITE is better than storing a
    // row that silently never fires.
    const sender = args.senderPattern ? normalizePattern(args.senderPattern) : undefined;
    const subject = args.subjectPattern?.trim() || undefined;
    const category = args.category?.trim() || undefined;
    const accountLabel = args.accountLabel?.trim().toLowerCase() || undefined;
    if (!sender && !subject && !category) {
      throw new Error("a rule needs at least one of: sender, subject, category");
    }

    // No UNIQUE constraint in Convex — index plus check-then-insert inside
    // this one transaction, same pattern as noiseSenders and userContext.
    const existing = await ctx.db
      .query("emailRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(MAX_RULES);

    const duplicate = existing.find(
      (r) =>
        r.senderPattern === sender &&
        r.subjectPattern === subject &&
        r.category === category &&
        r.accountLabel === accountLabel &&
        r.action === args.action,
    );
    if (duplicate) return { ruleId: duplicate._id, created: false };

    if (existing.length >= MAX_RULES) {
      throw new Error(`you already have ${MAX_RULES} rules — remove one first`);
    }

    const ruleId = await ctx.db.insert("emailRules", {
      userId: args.userId,
      senderPattern: sender,
      subjectPattern: subject,
      category,
      accountLabel,
      action: args.action,
      reason: args.reason,
      createdAt: Date.now(),
    });
    return { ruleId, created: true };
  },
});

/**
 * Remove by fragment, not by id — the model never sees a rule id, and asking
 * the user for one would be absurd. Same id-or-fragment shape as tasks,
 * instructions and userContext.
 */
export const removeByFragment = internalMutation({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const fragment = args.fragment.trim().toLowerCase();
    const rows = await ctx.db
      .query("emailRules")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(MAX_RULES);

    const hit = rows.find((r) =>
      [r.senderPattern, r.subjectPattern, r.category, r.accountLabel, r.reason]
        .filter((x): x is string => Boolean(x))
        .some((field) => field.toLowerCase().includes(fragment)),
    );
    if (!hit) return { removed: false };

    await ctx.db.delete(hit._id);
    return { removed: true, senderPattern: hit.senderPattern, subjectPattern: hit.subjectPattern };
  },
});
