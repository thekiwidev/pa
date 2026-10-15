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
    /**
     * Permission to overwrite an EXISTING row's label. Default false, and
     * that default is the whole point.
     *
     * `/reconnect ade.propmail@gmail.com` used to reach here with
     * label="adepropmailgmailcom" — the address run through /connect's
     * `[^a-z0-9_-]` stripper — and this mutation cheerfully renamed the
     * mailbox the user had connected as "primary". Every 7-day Testing-mode
     * expiry destroyed the label, after which `accountLabel: "primary"`
     * matched nothing and the assistant answered "No mailbox connected."
     *
     * assistant.ts's reconnectCommand no longer sends a mangled label, but
     * the guard lives HERE as well so no future caller can reintroduce the
     * bug. A label is identity; renaming one is a deliberate act, never a
     * side effect of refreshing a credential.
     */
    relabel: v.optional(v.boolean()),
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
        ...(args.relabel === true ? { label: args.label } : {}),
        status: "ACTIVE",
      });
      return { accountId: match._id, created: false, label: match.label };
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
    return { accountId, created: true, label: args.label };
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

/**
 * Every ACTIVE account across all users, of EVERY provider.
 *
 * Callers must filter by provider. The Gmail sync cron did not, and fed a
 * Linear API key to Google's token endpoint as though it were a refresh
 * token — which marked the Linear account NEEDS_REAUTH and silently took the
 * task backend down with it.
 */
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
 * Record a push watch, or advance the history cursor.
 *
 * Separate from markSynced because a push and a poll are different clocks:
 * `lastSyncedAt` answers "when did we last look", `lastHistoryId` answers
 * "what have we already seen". Advancing one from the other would make a
 * failed history fetch look like a successful sync.
 */
export const markWatched = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    historyId: v.optional(v.string()),
    watchExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("connectedAccounts", args.accountId, {
      ...(args.historyId ? { lastHistoryId: args.historyId } : {}),
      ...(args.watchExpiresAt !== undefined ? { watchExpiresAt: args.watchExpiresAt } : {}),
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
