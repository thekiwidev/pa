import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Same cap and the same reason as connectors/gmail/normalize.ts: Convex bills
 * database BANDWIDTH, so a 200 KB transcript re-read by every list query is
 * the expensive mistake. The extraction is the part that gets re-read.
 */
const TRANSCRIPT_CAP_BYTES = 32 * 1024;

function capTranscript(text: string): string {
  if (text.length <= TRANSCRIPT_CAP_BYTES) return text;
  const kept = text.slice(0, TRANSCRIPT_CAP_BYTES);
  return `${kept}\n\n[…truncated, ${text.length - TRANSCRIPT_CAP_BYTES} more characters]`;
}

export const record = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    occurredAt: v.number(),
    transcript: v.string(),
    extraction: v.any(),
    createdTaskIds: v.array(v.id("tasks")),
    createdReminderIds: v.array(v.id("reminders")),
  },
  handler: async (ctx, args) =>
    await ctx.db.insert("meetings", {
      userId: args.userId,
      title: args.title,
      occurredAt: args.occurredAt,
      transcript: capTranscript(args.transcript),
      extraction: args.extraction,
      createdTaskIds: args.createdTaskIds,
      createdReminderIds: args.createdReminderIds,
    }),
});

export const list = internalQuery({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db
      .query("meetings")
      .withIndex("by_user_occurred", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(Math.min(args.limit ?? 10, 25)),
});

export const getById = internalQuery({
  args: { userId: v.id("users"), meetingId: v.id("meetings") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.meetingId);
    // An id is a proposal, not proof of access — same check as every other
    // id-taking read in this project.
    return row && row.userId === args.userId ? row : null;
  },
});

/**
 * "What did we decide in the Momentum call?" — the model supplies words, code
 * resolves the foreign key. Same id-or-fragment shape as tasks.findByTitle.
 */
export const findByFragment = internalQuery({
  args: { userId: v.id("users"), fragment: v.string() },
  handler: async (ctx, args) => {
    const fragment = args.fragment.trim().toLowerCase();
    const rows = await ctx.db
      .query("meetings")
      .withIndex("by_user_occurred", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(50);
    return rows.find((m) => m.title.toLowerCase().includes(fragment)) ?? null;
  },
});
