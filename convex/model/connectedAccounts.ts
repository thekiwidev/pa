import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * The credential columns hold ciphertext only. Nothing in this file can
 * decrypt — that happens in an action, via convex/security/crypto.ts, at the
 * moment of use. A mutation has no reason to hold a plaintext credential and
 * on Convex it structurally cannot need one: it cannot fetch.
 */
export const upsert = internalMutation({
  args: {
    userId: v.id("users"),
    provider: v.string(),
    accountEmail: v.string(),
    displayName: v.string(),
    label: v.string(),
    encryptedCredentials: v.bytes(),
    credentialIv: v.bytes(),
    credentialAuthTag: v.bytes(),
    scopesGranted: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_user_provider", (q) =>
        q.eq("userId", args.userId).eq("provider", args.provider),
      )
      .take(25);

    const match = existing.find((a) => a.accountEmail === args.accountEmail);

    if (match) {
      await ctx.db.patch("connectedAccounts", match._id, {
        encryptedCredentials: args.encryptedCredentials,
        credentialIv: args.credentialIv,
        credentialAuthTag: args.credentialAuthTag,
        scopesGranted: args.scopesGranted,
        label: args.label,
        status: "ACTIVE",
      });
      return { accountId: match._id, created: false };
    }

    const accountId = await ctx.db.insert("connectedAccounts", {
      userId: args.userId,
      provider: args.provider,
      accountEmail: args.accountEmail,
      displayName: args.displayName,
      label: args.label,
      status: "ACTIVE",
      encryptedCredentials: args.encryptedCredentials,
      credentialIv: args.credentialIv,
      credentialAuthTag: args.credentialAuthTag,
      scopesGranted: args.scopesGranted,
    });
    return { accountId, created: true };
  },
});

export const listForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("connectedAccounts")
      .withIndex("by_user_provider", (q) => q.eq("userId", args.userId))
      .take(25);
  },
});

/** Every ACTIVE account across all users — what the sync cron walks. */
export const listActive = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("connectedAccounts")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .take(50);
  },
});

export const get = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => await ctx.db.get("connectedAccounts", args.accountId),
});

export const markSynced = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    lastHistoryId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("connectedAccounts", args.accountId, {
      lastSyncedAt: Date.now(),
      ...(args.lastHistoryId ? { lastHistoryId: args.lastHistoryId } : {}),
    });
  },
});

/**
 * A Testing-mode Google app issues refresh tokens that expire after SEVEN
 * DAYS. This is not an error path, it is the normal weekly path — which is why
 * /reconnect is built in this phase and not later.
 */
export const markNeedsReauth = internalMutation({
  args: { accountId: v.id("connectedAccounts"), reason: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch("connectedAccounts", args.accountId, {
      status: "NEEDS_REAUTH",
    });
    await ctx.db.insert("auditLogs", {
      actor: "system",
      action: "account.needs_reauth",
      targetType: "connectedAccounts",
      targetId: args.accountId,
      accountId: args.accountId,
      args: { reason: args.reason.slice(0, 300) },
      result: "error",
    });
  },
});
