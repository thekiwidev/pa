import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { seal, open } from "./security/crypto";
import {
  exchangeCode,
  refreshAccessToken,
  GMAIL_SEND_SCOPES,
  TokenRevoked,
} from "./connectors/gmail/oauth";
import {
  getProfile,
  listMessages,
  getMessage,
  sendMessage as sendGmailMessage,
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
      scopesGranted: tokens.scopes.length ? tokens.scopes : [...GMAIL_SEND_SCOPES],
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
    const [isNoise, person, projects, rules] = await Promise.all([
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
