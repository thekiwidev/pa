import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { seal, open } from "./security/crypto";
import {
  exchangeCode,
  refreshAccessToken,
  GMAIL_READONLY_SCOPES,
  TokenRevoked,
} from "./connectors/gmail/oauth";
import { getProfile, listMessages, getMessage, GmailApiError } from "./connectors/gmail/client";
import { normalizeMessage } from "./connectors/gmail/normalize";
import { sendMessage } from "./channels/telegram";

/** How far back a sync looks. Gmail's `q` syntax. */
const SYNC_WINDOW = "newer_than:2d";
const MAX_PER_SYNC = 40;

/**
 * Finish the OAuth handshake: swap the code for tokens, find out which mailbox
 * was actually authorized, encrypt the refresh token, store the account.
 *
 * Runs as an action because it fetches. The credential is encrypted HERE and
 * only ciphertext crosses into a mutation.
 */
export const completeConnect = internalAction({
  args: {
    code: v.string(),
    userId: v.id("users"),
    label: v.string(),
    telegramId: v.string(),
  },
  handler: async (ctx, args) => {
    const tokens = await exchangeCode(args.code);

    if (!tokens.refreshToken) {
      // access_type=offline + prompt=consent should guarantee one. Without it
      // the account works for an hour and then silently dies.
      throw new Error(
        "Google returned no refresh token. Remove this app at " +
          "myaccount.google.com/permissions and connect again.",
      );
    }

    // Which mailbox did the user actually pick? Never assume — they may have
    // chosen a different account at the Google screen than they intended.
    // gmail.readonly covers /profile, so this needs no extra scope.
    const profile = await getProfile(tokens.accessToken);

    const sealed = await seal(tokens.refreshToken);

    const result = await ctx.runMutation(internal.model.connectedAccounts.upsert, {
      userId: args.userId,
      provider: "gmail",
      accountEmail: profile.emailAddress,
      displayName: profile.emailAddress,
      label: args.label,
      encryptedCredentials: sealed.ciphertext,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      scopesGranted: tokens.scopes.length ? tokens.scopes : [...GMAIL_READONLY_SCOPES],
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "user",
      action: "account.connect",
      targetType: "connectedAccounts",
      targetId: result.accountId,
      args: { provider: "gmail", label: args.label, email: profile.emailAddress },
      result: "ok",
    });

    await sendMessage(
      args.telegramId,
      `✅ Connected ${profile.emailAddress} as "${args.label}".\n` +
        `Read-only. Syncing now — including spam.`,
    );

    await ctx.runAction(internal.gmail.syncAccount, { accountId: result.accountId });
    return { accountEmail: profile.emailAddress };
  },
});

/**
 * Decrypt the refresh token and mint an access token.
 *
 * The plaintext lives only inside this function's frame, is never written to
 * the database, never logged, and never enters a prompt.
 */
async function accessTokenFor(
  ctx: ActionCtx,
  accountId: Id<"connectedAccounts">,
): Promise<string> {
  const account = await ctx.runQuery(internal.model.connectedAccounts.get, { accountId });
  if (!account) throw new Error("account not found");

  const refreshToken = await open({
    ciphertext: account.encryptedCredentials,
    iv: account.credentialIv,
    authTag: account.credentialAuthTag,
  });

  const tokens = await refreshAccessToken(refreshToken);
  return tokens.accessToken;
}

/**
 * A live, on-demand Gmail query — NOT the cached `emailMessages` table.
 *
 * `syncAccount` only ever looks at the last 2 days; that cap is a cost
 * decision for the passive background sync, not a limit on what the user can
 * actually ask for. When someone says "check my spam, all of it" or a normal
 * search comes back empty and they push back, this is what runs instead:
 * a real Gmail API query with no `newer_than` clause (Gmail's default is
 * unbounded), matches get normalized and upserted into the permanent cache
 * exactly like a background sync would, and are returned immediately.
 *
 * Capped at DEEP_SEARCH_MAX results — this is user-triggered and synchronous
 * from the model's point of view (it's waiting on the tool result), so it
 * cannot be allowed to run away on a huge mailbox.
 */
const DEEP_SEARCH_MAX = 25;

export const deepSearch = internalAction({
  args: {
    accountId: v.id("connectedAccounts"),
    /** Gmail's own `q` syntax, e.g. `from:recruiter label:spam`. Omit for
     *  "everything matching the label filter, no keyword". */
    query: v.optional(v.string()),
    /** Gmail label to filter to, e.g. "SPAM". Combined with `query` via AND. */
    gmailLabel: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ emailMessageIds: string[]; scanned: number }> => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status !== "ACTIVE") {
      throw new Error("account is not active");
    }

    const accessToken = await accessTokenFor(ctx, args.accountId);

    const gmailQuery = [args.query, args.gmailLabel ? `label:${args.gmailLabel}` : undefined]
      .filter(Boolean)
      .join(" ");

    const listed = await listMessages(accessToken, {
      // No `newer_than` — Gmail's default is unbounded, which is the whole
      // point: this is the escape hatch from the 2-day background-sync cap.
      query: gmailQuery,
      maxResults: DEEP_SEARCH_MAX,
    });

    const emailMessageIds: string[] = [];
    for (const ref of listed.messages ?? []) {
      const full = await getMessage(accessToken, ref.id);
      const normalized = normalizeMessage(full);
      const { bodyTruncated: _bodyTruncated, ...row } = normalized;

      const result = await ctx.runMutation(internal.model.emailMessages.upsert, {
        accountId: args.accountId,
        ...row,
      });
      emailMessageIds.push(result.emailMessageId);
    }

    await ctx.runMutation(internal.model.audit.record, {
      actor: "llm_proposed",
      action: "gmail.deep_search",
      targetType: "connectedAccounts",
      targetId: args.accountId,
      args: { query: gmailQuery || "(none)", found: emailMessageIds.length },
      result: "ok",
    });

    return { emailMessageIds, scanned: listed.messages?.length ?? 0 };
  },
});

export const syncAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status === "REVOKED") return;

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, args.accountId);
    } catch (error) {
      // A Testing-mode refresh token expires after SEVEN DAYS. This is the
      // normal weekly path, not an exception — tell the user how to fix it.
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(ctx, account.userId, args.accountId, account.accountEmail);
        return;
      }
      throw error;
    }

    let stored = 0;
    let fresh = 0;

    try {
      const listed = await listMessages(accessToken, {
        query: SYNC_WINDOW,
        maxResults: MAX_PER_SYNC,
      });

      for (const ref of listed.messages ?? []) {
        // One fetch, held in memory, passed through as an argument — rather
        // than several functions each re-reading the row. Convex charges for
        // database BANDWIDTH, and re-reads are what spend it.
        const full = await getMessage(accessToken, ref.id);
        const normalized = normalizeMessage(full);

        const { bodyTruncated: _bodyTruncated, ...row } = normalized;
        const result = await ctx.runMutation(internal.model.emailMessages.upsert, {
          accountId: args.accountId,
          ...row,
        });
        stored++;
        if (result.created) fresh++;
      }

      await ctx.runMutation(internal.model.connectedAccounts.markSynced, {
        accountId: args.accountId,
      });

      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "gmail.sync",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: { seen: stored, new: fresh, window: SYNC_WINDOW },
        result: "ok",
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof GmailApiError && error.isAuthFailure) {
        await notifyNeedsReauth(ctx, account.userId, args.accountId, account.accountEmail);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.model.audit.record, {
        actor: "scheduler",
        action: "gmail.sync",
        targetType: "connectedAccounts",
        targetId: args.accountId,
        args: { seen: stored },
        result: "error",
        errorMessage: detail.slice(0, 500),
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
});

/** The cron target. One account failing must not stop the others. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    for (const account of accounts) {
      try {
        await ctx.runAction(internal.gmail.syncAccount, { accountId: account._id });
      } catch (error) {
        console.warn(
          `gmail_sync_failed account=${account._id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
});

async function notifyNeedsReauth(
  ctx: ActionCtx,
  userId: Id<"users">,
  accountId: Id<"connectedAccounts">,
  accountEmail: string,
) {
  await ctx.runMutation(internal.model.connectedAccounts.markNeedsReauth, {
    accountId,
    reason: "refresh token rejected",
  });

  const user = await ctx.runQuery(internal.model.users.get, { userId });
  if (!user) return;

  await sendMessage(
    user.telegramId,
    `⚠️ ${accountEmail} needs re-authorizing — Google rejected the saved token.\n` +
      `This happens every 7 days while the app is in Testing mode.\n\n` +
      `Send: /reconnect ${accountEmail}`,
  );
}
