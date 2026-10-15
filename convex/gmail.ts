import { internalAction, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { seal, open } from "./security/crypto";
import {
  exchangeCode,
  refreshAccessToken,
  GOOGLE_CONNECT_SCOPES,
  TokenRevoked,
} from "./connectors/gmail/oauth";
import {
  getProfile,
  listMessages,
  getMessage,
  sendMessage as sendGmailMessage,
  watchMailbox,
  listHistory,
  modifyMessage,
  listLabels,
  createLabel,
  GmailApiError,
} from "./connectors/gmail/client";
import { normalizeMessage, type NormalizedEmail } from "./connectors/gmail/normalize";
import { runTask } from "./ai/registry";
import { prefilter } from "./lib/email/prefilter";
import { applyPriorityRules, parsePriorityRules } from "./lib/email/priority";
import { describeRule, matchRules } from "./lib/email/rules";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  CLASSIFIER_VERSION,
  buildClassificationInput,
  parseClassifierResponse,
  applyFloor,
  applyOverrides,
  type Importance,
} from "./lib/email/classification";
import { sendMessage } from "./channels/telegram";

/** How far back a sync looks. Gmail's `q` syntax. */
const SYNC_WINDOW = "newer_than:2d";

/** What archive / label / mark-read need. Checked before every one of them. */
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
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
    /** False on /reconnect: refreshing a credential must never rename the
     *  mailbox. See the note on connectedAccounts.upsert. */
    relabel: v.optional(v.boolean()),
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
      // What Google SAID it granted, always preferred over what we asked for.
      // The fallback matters only if Google omits `scope` from the response;
      // assuming the full list there would let a Calendar tool believe it has
      // a permission the token does not carry.
      scopesGranted: tokens.scopes.length ? tokens.scopes : [...GOOGLE_CONNECT_SCOPES],
      relabel: args.relabel !== false,
    });

    await ctx.runMutation(internal.model.audit.record, {
      actor: "user",
      action: "account.connect",
      targetType: "connectedAccounts",
      targetId: result.accountId,
      args: { provider: "gmail", label: result.label, email: profile.emailAddress },
      result: "ok",
    });

    await sendMessage(
      args.telegramId,
      `✅ Connected ${profile.emailAddress} as "${result.label}".\n` +
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
 * Apply a label change to one message, in Gmail and in the local cache.
 *
 * Archive, mark-read and mark-unread are all this one operation — Gmail
 * models them as label edits, which is also why all three are reversible.
 * Nothing here can destroy a message: `gmail.modify` cannot permanently
 * delete, and this project never requests the scope that can.
 *
 * The local row is patched from Gmail's OWN response rather than from what
 * we asked for, so a partially-applied change is reflected honestly.
 */
export const applyLabels = internalAction({
  args: {
    emailMessageId: v.id("emailMessages"),
    addLabelIds: v.optional(v.array(v.string())),
    removeLabelIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ labelIds: string[] }> => {
    const message = await ctx.runQuery(internal.model.emailMessages.getById, {
      emailMessageId: args.emailMessageId,
    });
    if (!message) throw new Error("no email matching that");

    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: message.accountId,
    });
    if (!account || account.status !== "ACTIVE") throw new Error("that mailbox is not connected");

    if (!account.scopesGranted.includes(GMAIL_MODIFY_SCOPE)) {
      throw new Error(
        `${account.accountEmail} was connected before mailbox actions existed, and ` +
          "Google cannot add the permission to an existing token — send " +
          `/reconnect ${account.accountEmail} once and this will work.`,
      );
    }

    const accessToken = await accessTokenFor(ctx, message.accountId);
    const result = await modifyMessage(accessToken, message.providerMessageId, {
      addLabelIds: args.addLabelIds,
      removeLabelIds: args.removeLabelIds,
    });

    const labelIds = result.labelIds ?? message.labelIds;
    await ctx.runMutation(internal.model.emailMessages.setLabels, {
      emailMessageId: args.emailMessageId,
      labelIds,
    });

    return { labelIds };
  },
});

/** Resolve a label NAME to its Gmail id, creating it if it does not exist. */
export const resolveLabelId = internalAction({
  args: { accountId: v.id("connectedAccounts"), name: v.string() },
  handler: async (ctx, args): Promise<{ labelId: string; created: boolean }> => {
    const accessToken = await accessTokenFor(ctx, args.accountId);
    const labels = await listLabels(accessToken);

    const needle = args.name.trim().toLowerCase();
    const found = labels.find((l) => l.name.toLowerCase() === needle);
    if (found) return { labelId: found.id, created: false };

    const created = await createLabel(accessToken, args.name.trim());
    return { labelId: created.id, created: true };
  },
});

/**
 * Register (or renew) a Gmail push watch for one mailbox.
 *
 * The returned expiration is at most 7 days out and Google recommends daily
 * renewal, so this is called by a cron rather than once at connect time. A
 * lapsed watch fails SILENTLY — no error, just no notifications ever again —
 * which is also why the polling sync stays in place as a safety net rather
 * than being replaced by this.
 */
export const watchAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args): Promise<{ watched: boolean; reason?: string }> => {
    const topic = process.env.GOOGLE_PUBSUB_TOPIC;
    if (!topic) return { watched: false, reason: "GOOGLE_PUBSUB_TOPIC is not set" };

    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.provider !== "gmail" || account.status !== "ACTIVE") {
      return { watched: false, reason: "account is not an active Gmail account" };
    }

    try {
      const accessToken = await accessTokenFor(ctx, args.accountId);
      const result = await watchMailbox(accessToken, topic);

      await ctx.runMutation(internal.model.connectedAccounts.markWatched, {
        accountId: args.accountId,
        historyId: result.historyId,
        // Google returns the expiration as ms-epoch in a STRING.
        watchExpiresAt: Number(result.expiration),
      });
      return { watched: true };
    } catch (error) {
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(
          ctx,
          account.userId,
          args.accountId,
          account.accountEmail,
          account.label,
        );
        return { watched: false, reason: "needs re-auth" };
      }
      // A watch failure must never take down the poll. Report and continue.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`gmail_watch_failed account=${args.accountId}: ${detail}`);
      return { watched: false, reason: detail.slice(0, 200) };
    }
  },
});

/** Renew every active mailbox's watch. Cheap, idempotent, runs daily. */
export const watchAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ skipped?: string; renewed?: number }> => {
    if (!process.env.GOOGLE_PUBSUB_TOPIC) return { skipped: "no topic configured" };

    const accounts = (
      await ctx.runQuery(internal.model.connectedAccounts.listActive, {})
    ).filter((a) => a.provider === "gmail");

    for (const account of accounts) {
      await ctx.runAction(internal.gmail.watchAccount, { accountId: account._id });
    }
    return { renewed: accounts.length };
  },
});

/**
 * The push path: sync only what changed since the stored history cursor.
 *
 * Falls back to the ordinary windowed sync when Gmail no longer holds that
 * far back. History is kept for a limited period, so a mailbox that was
 * quiet for a week comes back expired — treating that as an error would mean
 * silently missing every message that arrived in the meantime.
 */
export const syncFromHistory = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args): Promise<{ synced: number; fellBack: boolean }> => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.provider !== "gmail" || account.status !== "ACTIVE") {
      return { synced: 0, fellBack: false };
    }

    if (!account.lastHistoryId) {
      await ctx.runAction(internal.gmail.syncAccount, { accountId: args.accountId });
      return { synced: 0, fellBack: true };
    }

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, args.accountId);
    } catch (error) {
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(
          ctx,
          account.userId,
          args.accountId,
          account.accountEmail,
          account.label,
        );
        return { synced: 0, fellBack: false };
      }
      throw error;
    }

    const history = await listHistory(accessToken, account.lastHistoryId);

    if (history.expired) {
      await ctx.runAction(internal.gmail.syncAccount, { accountId: args.accountId });
      return { synced: 0, fellBack: true };
    }

    // One message can appear in several history records. Deduplicate before
    // fetching, or a busy thread costs a getMessage per mention.
    const ids = new Set<string>();
    for (const record of history.records) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }

    let stored = 0;
    for (const messageId of ids) {
      try {
        const full = await getMessage(accessToken, messageId);
        const normalized = normalizeMessage(full);
        const { bodyTruncated: _bodyTruncated, ...row } = normalized;
        const result = await ctx.runMutation(internal.model.emailMessages.upsert, {
          accountId: args.accountId,
          ...row,
        });
        if (result.created) stored++;
      } catch (error) {
        // One unreadable message must not abandon the rest of the batch.
        console.warn(`gmail_history_message_failed id=${messageId}: ${String(error)}`);
      }
    }

    // Classify in one pass afterwards, exactly as the polling sync does —
    // classification is the expensive half and batching it keeps a burst of
    // pushes from becoming a burst of model calls.
    if (stored > 0) {
      await ctx.runAction(internal.gmail.classifyBacklog, {
        accountId: args.accountId,
        limit: Math.min(stored, 20),
      });
    }

    if (history.historyId) {
      await ctx.runMutation(internal.model.connectedAccounts.markWatched, {
        accountId: args.accountId,
        historyId: history.historyId,
      });
    }

    return { synced: stored, fellBack: false };
  },
});

/** Resolve a pushed mailbox ADDRESS to the account row it belongs to. */
export const accountByEmail = internalQuery({
  args: { accountEmail: v.string() },
  // Explicit return type: without it this handler's inferred type flows
  // through _generated/api and silently degrades ctx.runQuery types across
  // assistant.ts to `any`. Same trap debug:planOnly documents.
  handler: async (ctx, args): Promise<{ accountId: Id<"connectedAccounts"> } | null> => {
    const rows = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .take(50);
    const needle = args.accountEmail.trim().toLowerCase();
    const found = rows.find(
      (r) => r.provider === "gmail" && r.accountEmail.toLowerCase() === needle,
    );
    return found ? { accountId: found._id } : null;
  },
});

/**
 * A fresh Google access token for one account, for callers outside this file.
 *
 * An action, not a plain export, because the plaintext refresh token must
 * never leave this module's frame — and because Calendar and Drive ride the
 * same grant, so they need exactly this and nothing else from Gmail.
 */
export const accessTokenForAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args): Promise<string> => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status !== "ACTIVE") throw new Error("account is not active");
    return await accessTokenFor(ctx, args.accountId);
  },
});

/**
 * A live, on-demand Gmail query — NOT the cached `emailMessages` table.
 *
 * `syncAccount` only ever looks at the last 2 days; that cap is a cost
 * decision for the passive background sync, not a limit on what the user can
 * actually ask for. When someone asks for a specific message, or pushes back
 * on an empty result, this is what runs instead: a real Gmail API query,
 * whose matches get normalized and upserted into the permanent cache exactly
 * like a background sync would, and are returned immediately.
 *
 * The `q` string arrives ALREADY BUILT, from lib/email/gmailQuery.ts. This
 * action used to assemble it — and to accept the model's raw `query` string
 * as Gmail syntax, which is the model writing a query language (invariant
 * I-1 inverted). Building it from typed fields in a pure, tested module is
 * what lets `from:` work at all while making it impossible for a free-text
 * search to smuggle an operator in.
 *
 * Capped at DEEP_SEARCH_MAX — this is user-triggered and synchronous from the
 * model's point of view (it is waiting on the tool result), so it cannot be
 * allowed to run away on a huge mailbox.
 */
const DEEP_SEARCH_MAX = 25;

export const deepSearch = internalAction({
  args: {
    accountId: v.id("connectedAccounts"),
    /** A complete Gmail `q` string, built by lib/email/gmailQuery.ts. */
    query: v.optional(v.string()),
    /** Caller's own cap, clamped to DEEP_SEARCH_MAX. */
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ emailMessageIds: string[]; scanned: number }> => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account || account.status !== "ACTIVE") {
      throw new Error("account is not active");
    }

    const accessToken = await accessTokenFor(ctx, args.accountId);

    const gmailQuery = args.query ?? "";

    const listed = await listMessages(accessToken, {
      // No `newer_than` here: any date bound the caller wanted is already in
      // `q` as after:/before:. This is the escape hatch from the 2-day
      // background-sync cap.
      query: gmailQuery,
      maxResults: Math.min(args.maxResults ?? DEEP_SEARCH_MAX, DEEP_SEARCH_MAX),
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

/** The subset of Phase 4's ImportanceSchema this phase actually reads. */
interface ClassificationResult {
  importance: string;
  whyItMatters?: string;
  deadlineMentioned?: string | null;
  /**
   * A NEVER_ALERT rule matched. The message is still classified and still
   * appears in the brief and in searches — only the real-time card is
   * suppressed. "Stop interrupting me about X" and "never show me X" are
   * different requests and this is the weaker one.
   */
  neverAlert?: boolean;
}

/** Used when the model call fails outright or its response fails to parse. */
const FALLBACK_CLASSIFICATION: Importance = {
  importance: "NORMAL",
  confidence: 0,
  whyItMatters: "Classifier response could not be parsed; defaulted to NORMAL.",
  category: "OTHER",
  deadlineMentioned: null,
  requestedOfYou: null,
  suggestedAction: "READ",
  projectHint: null,
};

/**
 * Runs once for every NEWLY stored message. Never throws — a classification
 * failure must not stop the rest of the sync loop or drop the message from
 * emailMessages; the row keeps its data even if this writes NORMAL onto it.
 */
async function classifyMessage(
  ctx: ActionCtx,
  userId: Id<"users">,
  emailMessageId: Id<"emailMessages">,
  normalized: NormalizedEmail,
  /** connectedAccounts.priorityRules for the mailbox this arrived in. */
  priorityRules?: unknown,
  /** The label of that mailbox, so a rule can be scoped to one inbox. */
  accountLabel?: string,
): Promise<ClassificationResult> {
  try {
    const [isNoise, person, projects, rules, ownerContext] = await Promise.all([
      ctx.runQuery(internal.model.noiseSenders.matches, {
        userId,
        fromAddress: normalized.fromAddress,
      }),
      ctx.runQuery(internal.model.people.getByEmail, {
        userId,
        email: normalized.fromAddress,
      }),
      ctx.runQuery(internal.model.projects.listActive, { userId, limit: 25 }),
      ctx.runQuery(internal.model.emailRules.listForMatching, { userId }),
      ctx.runQuery(internal.model.userContext.list, { userId }),
    ]);

    const haystack = `${normalized.subject ?? ""} ${normalized.bodyText ?? ""}`.toLowerCase();
    const projectNames = projects.map((p) => p.name);
    const projectKeywordHit = projectNames.some((name) => haystack.includes(name.toLowerCase()));

    const senderImportance = person?.importance as
      | "CRITICAL"
      | "HIGH"
      | "NORMAL"
      | "LOW"
      | undefined;

    // Matching is pure; only fetching the rows needs ctx.
    const userRule = matchRules(
      {
        fromAddress: normalized.fromAddress,
        subject: normalized.subject,
        labelIds: normalized.labelIds,
        accountLabel,
      },
      rules,
    );

    const verdict = prefilter({
      isNoiseSender: isNoise,
      labelIds: normalized.labelIds,
      hasListUnsubscribe: Boolean(normalized.listUnsubscribe),
      senderImportance,
      projectKeywordHit,
      userRule,
    });

    if (verdict.skip) {
      await ctx.runMutation(internal.model.emailMessages.recordClassification, {
        emailMessageId,
        importance: verdict.importance,
        classification: {
          prefilterReason: verdict.reason,
          // Which rule silenced it, so "why didn't I see X?" is answerable
          // from the row rather than by re-deriving the match.
          ...(userRule ? { matchedRule: describeRule(userRule) } : {}),
        },
        classifierVersion: CLASSIFIER_VERSION,
      });
      return { importance: verdict.importance };
    }

    const result = await runTask("CLASSIFY_IMPORTANCE", {
      system: CLASSIFICATION_SYSTEM_PROMPT,
      input: buildClassificationInput({
        fromAddress: normalized.fromAddress,
        fromName: normalized.fromName,
        subject: normalized.subject,
        isInSpam: normalized.labelIds.includes("SPAM"),
        spf: normalized.authResults?.spf,
        dkim: normalized.authResults?.dkim,
        dmarc: normalized.authResults?.dmarc,
        senderImportance: person?.importance,
        knownProjects: projectNames,
        ownerFacts: ownerContext.map((c) => c.text),
      }),
      // The body reaches the model ONLY here — never merged into `input`.
      untrusted: [{ label: "email_body", content: normalized.bodyText ?? "(no body)" }],
      maxOutputTokens: 512,
    });

    const parsed = parseClassifierResponse(result.text);
    let classification = parsed.ok && parsed.value ? parsed.value : FALLBACK_CLASSIFICATION;

    if (!parsed.ok) {
      console.warn(`classify_parse_failed emailMessageId=${emailMessageId}: ${parsed.error}`);
    }

    if (verdict.floor) classification = applyFloor(classification, verdict.floor);

    classification = applyOverrides(classification, {
      labelIds: normalized.labelIds,
      dmarc: normalized.authResults?.dmarc,
      subject: normalized.subject,
      bodyText: normalized.bodyText,
    });

    // Per-mailbox floors and ceilings, applied to the classifier's OUTPUT.
    // Code, not prompt text: "every interview email from the recruiting
    // mailbox is at least CRITICAL" is a guarantee a rule engine can make
    // and a prompt instruction cannot.
    const adjusted = applyPriorityRules(
      classification.importance,
      classification.category,
      parsePriorityRules(priorityRules),
    );

    await ctx.runMutation(internal.model.emailMessages.recordClassification, {
      emailMessageId,
      importance: adjusted,
      classification,
      classifierVersion: CLASSIFIER_VERSION,
    });

    // neverAlert is a DELIVERY decision, not a classification — it is not
    // stored on the row, only carried to deliverIfDue. The message keeps its
    // real importance so the brief and searches still surface it.
    return { ...classification, importance: adjusted, neverAlert: verdict.neverAlert };
  } catch (error) {
    console.warn(
      `classify_failed emailMessageId=${emailMessageId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await ctx.runMutation(internal.model.emailMessages.recordClassification, {
      emailMessageId,
      importance: FALLBACK_CLASSIFICATION.importance,
      classification: FALLBACK_CLASSIFICATION,
      classifierVersion: CLASSIFIER_VERSION,
    });

    return FALLBACK_CLASSIFICATION;
  }
}

/**
 * Classify mail that synced BEFORE this phase existed.
 *
 * `classifyMessage` only fires for newly-created rows, so without this the
 * phase would silently apply to future mail only and the existing corpus
 * would stay unlabelled forever — invisible, because nothing errors. Step 7's
 * `unclassified` query exists for exactly this and had no caller.
 *
 * Bounded per invocation: this is one model call per message, so it walks a
 * batch and reports what is left rather than looping until done.
 */
export const classifyBacklog = internalAction({
  args: { accountId: v.id("connectedAccounts"), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ classified: number; remaining: number }> => {
    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: args.accountId,
    });
    if (!account) throw new Error("account not found");

    const pending = await ctx.runQuery(internal.model.emailMessages.unclassified, {
      accountId: args.accountId,
      limit: args.limit ?? 10,
    });

    for (const message of pending) {
      await classifyMessage(ctx, account.userId, message._id, {
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        subject: message.subject,
        bodyText: message.bodyText,
        snippet: message.snippet,
        labelIds: message.labelIds,
        listUnsubscribe: message.listUnsubscribe,
        authResults: message.authResults,
      } as NormalizedEmail);
    }

    const left = await ctx.runQuery(internal.model.emailMessages.unclassified, {
      accountId: args.accountId,
      limit: 50,
    });

    return { classified: pending.length, remaining: left.length };
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
    // Defence in depth against the bug fixed in syncAll: this action reads a
    // GOOGLE refresh token out of the row, so pointing it at any other
    // provider destroys that account's status for a credential Google was
    // never going to accept.
    if (account.provider !== "gmail") return;

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, args.accountId);
    } catch (error) {
      // A Testing-mode refresh token expires after SEVEN DAYS. This is the
      // normal weekly path, not an exception — tell the user how to fix it.
      if (error instanceof TokenRevoked) {
        await notifyNeedsReauth(
          ctx,
          account.userId,
          args.accountId,
          account.accountEmail,
          account.label,
        );
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
        if (result.created) {
          fresh++;
          const classified = await classifyMessage(
            ctx,
            account.userId,
            result.emailMessageId,
            normalized,
            account.priorityRules,
            account.label,
          );
          await deliverIfDue(ctx, account, result.emailMessageId, normalized, classified);
        }
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
        await notifyNeedsReauth(
          ctx,
          account.userId,
          args.accountId,
          account.accountEmail,
          account.label,
        );
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
    // GMAIL accounts only. `listActive` is provider-agnostic, so once a
    // non-Gmail connector existed this loop happily fed it a Linear API key
    // as if it were a Google refresh token: Google answered invalid_grant,
    // TokenRevoked propagated, and the LINEAR account was marked
    // NEEDS_REAUTH — permanently, within ten minutes of being connected, with
    // a Telegram alert telling the owner to "/reconnect linear". The task
    // backend then silently fell back to the local table.
    const accounts = (
      await ctx.runQuery(internal.model.connectedAccounts.listActive, {})
    ).filter((a) => a.provider === "gmail");

    // Concurrent, not sequential. Awaiting each account in turn meant a noisy
    // personal mailbox — many new messages, each needing its own getMessage
    // round trip — ran to completion before the recruiting mailbox made its
    // first Gmail call. With three mailboxes that is the difference between
    // "alerts arrive" and "alerts arrive for whichever inbox sorted first".
    // One account failing, or hanging, must not delay the others.
    await Promise.all(
      accounts.map(async (account) => {
        try {
          await ctx.runAction(internal.gmail.syncAccount, { accountId: account._id });
        } catch (error) {
          console.warn(
            `gmail_sync_failed account=${account._id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  },
});

async function notifyNeedsReauth(
  ctx: ActionCtx,
  userId: Id<"users">,
  accountId: Id<"connectedAccounts">,
  accountEmail: string,
  label: string,
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
      `Send: /reconnect ${accountEmail}\n` +
      `It stays labelled "${label}".`,
  );
}

/** 07:00-22:00 WAT is the HIGH-importance immediate-notify window. Outside
 *  it, HIGH mail queues for the morning brief (Phase 05B) instead of paging
 *  the phone overnight. CRITICAL bypasses this entirely -- it always pages. */
function withinImmediateWindow(nowMs: number, timezone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(nowMs)),
  );
  return hour >= 7 && hour < 22;
}

async function deliverIfDue(
  ctx: ActionCtx,
  account: { userId: Id<"users">; label: string },
  emailMessageId: Id<"emailMessages">,
  normalized: ReturnType<typeof normalizeMessage>,
  classified: ClassificationResult,
): Promise<void> {
  const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
  // A user rule saying "don't alert me about this" outranks importance.
  // Checked before the window so it holds at every hour of the day.
  if (classified.neverAlert) return;

  const immediate =
    classified.importance === "CRITICAL" ||
    (classified.importance === "HIGH" && withinImmediateWindow(Date.now(), timezone));

  if (!immediate) return;

  const user = await ctx.runQuery(internal.model.users.get, { userId: account.userId });
  if (!user) return;

  await ctx.runAction(internal.notify.sendAlert, {
    userId: account.userId,
    // A private Telegram chat's id equals the user's own id -- the same
    // fact notifyNeedsReauth above already relies on.
    chatId: user.telegramId,
    timezone,
    emailMessageId,
    threadKey: normalized.threadId,
    accountLabel: account.label,
    fromAddress: normalized.fromAddress,
    fromName: normalized.fromName,
    subject: normalized.subject,
    isSpam: normalized.labelIds.includes("SPAM"),
    importance: classified.importance,
    whyItMatters: classified.whyItMatters,
    deadlineMentioned: classified.deadlineMentioned ?? undefined,
    receivedAt: normalized.receivedAt,
  });
}

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * Called ONLY from tools/router.ts's dispatch(), once executeToolCall's gate
 * has confirmed a CONSUMED approval exists for this exact draft. Never called
 * directly from a tool proposal, and never from anywhere that could run it
 * twice for the same approval — consume() already guarantees single-use.
 */
export const sendReply = internalAction({
  args: { draftId: v.id("drafts"), approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const draft = await ctx.runQuery(internal.model.drafts.get, { draftId: args.draftId });
    if (!draft) throw new Error("draft not found");

    const message = await ctx.runQuery(internal.model.emailMessages.getById, {
      emailMessageId: draft.emailMessageId,
    });
    if (!message) throw new Error("source email not found");

    const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
      accountId: draft.accountId,
    });
    if (!account) throw new Error("account not found");

    // Reconnection reminder, surfaced as a real error rather than a Gmail
    // 403 the user has to decode themselves — see Step 8.
    if (!account.scopesGranted.includes(SEND_SCOPE)) {
      const detail = `${account.accountEmail} was connected before sending existed — reconnect it with /connect ${account.label} to grant send access.`;
      await failDraft(ctx, args, detail);
      throw new Error(detail);
    }

    let accessToken: string;
    try {
      accessToken = await accessTokenFor(ctx, draft.accountId);
    } catch (error) {
      await failDraft(ctx, args, error);
      throw error;
    }

    try {
      const sent = await sendGmailMessage(accessToken, {
        from: account.accountEmail,
        to: draft.toAddresses,
        cc: draft.ccAddresses,
        subject: draft.subject,
        bodyText: draft.bodyText,
        inReplyTo: draft.inReplyTo,
        referencesHeader: draft.referencesHeader,
        threadId: message.threadId,
      });

      if (sent.threadId !== message.threadId) {
        // Should be unreachable — Gmail refuses a raw message whose headers
        // don't match the target thread — but this is Step 3's "test it by
        // checking the sent message's threadId" made literal, not assumed.
        throw new Error(
          `sent message landed in thread ${sent.threadId}, expected ${message.threadId}`,
        );
      }

      await ctx.runMutation(internal.model.drafts.markSent, { draftId: args.draftId });
      await ctx.runMutation(internal.model.audit.record, {
        actor: "user",
        action: "email.send",
        targetType: "drafts",
        targetId: args.draftId,
        accountId: draft.accountId,
        approvalId: args.approvalId,
        args: { to: draft.toAddresses, cc: draft.ccAddresses, providerMessageId: sent.id },
        result: "ok",
      });
    } catch (error) {
      await failDraft(ctx, args, error);
      throw error;
    }
  },
});

async function failDraft(
  ctx: ActionCtx,
  args: { draftId: Id<"drafts">; approvalId: Id<"approvals"> },
  error: unknown,
) {
  const detail = error instanceof Error ? error.message : String(error);
  await ctx.runMutation(internal.model.drafts.markFailed, {
    draftId: args.draftId,
    reason: detail.slice(0, 300),
  });
  await ctx.runMutation(internal.model.audit.record, {
    actor: "system",
    action: "email.send",
    targetType: "drafts",
    targetId: args.draftId,
    approvalId: args.approvalId,
    args: {},
    result: "error",
    errorMessage: detail.slice(0, 500),
  });
}
