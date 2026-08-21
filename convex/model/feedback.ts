import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Predicted vs corrected, one row per correction. This is the entire
 * feedback loop for now: it costs almost nothing to record, and it is what
 * makes a later "how often does the classifier over-alert" pass possible
 * instead of guessed at.
 */
export const record = internalMutation({
  args: {
    userId: v.id("users"),
    emailMessageId: v.id("emailMessages"),
    predicted: v.string(),
    corrected: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("feedback", args);
  },
});
