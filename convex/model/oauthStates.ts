import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/** A handshake is valid for ten minutes. Long enough to tap a link and pick
 *  an account, short enough that a leaked URL is worthless by the time it
 *  reaches anyone. */
const TTL_MS = 10 * 60 * 1000;

export const issue = internalMutation({
  args: {
    userId: v.id("users"),
    label: v.string(),
    reconnectAccountId: v.optional(v.id("connectedAccounts")),
  },
  handler: async (ctx, args) => {
    // 256 bits from the CSPRNG. This nonce is the only thing standing between
    // a stranger and starting an OAuth flow against this deployment, so it is
    // not a counter and not a timestamp.
    const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

    await ctx.db.insert("oauthStates", {
      nonce,
      userId: args.userId,
      provider: "google",
      label: args.label,
      expiresAt: Date.now() + TTL_MS,
      reconnectAccountId: args.reconnectAccountId,
    });

    return { nonce, expiresAt: Date.now() + TTL_MS };
  },
});

/** Look without consuming — /oauth/google/start needs to know the nonce is
 *  live before redirecting, but the handshake is not finished yet. */
export const peek = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();

    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      await ctx.db.delete("oauthStates", row._id);
      return null;
    }
    return { label: row.label };
  },
});

/**
 * Consume atomically. Mutations are transactions, so read-then-delete here
 * genuinely cannot be raced — a replayed callback finds nothing.
 */
export const consume = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();

    if (!row) return null;
    await ctx.db.delete("oauthStates", row._id);

    if (row.expiresAt < Date.now()) return null;

    return {
      userId: row.userId,
      label: row.label,
      reconnectAccountId: row.reconnectAccountId,
    };
  },
});
