import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Convex has no UNIQUE constraint, so (accountId, providerMessageId)
 * uniqueness is enforced here: check the index, then insert, inside one
 * mutation. Mutations are ACID transactions, so that check-then-insert is
 * genuinely atomic — no race and no ON CONFLICT needed.
 */
export const upsert = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    providerMessageId: v.string(),
    threadId: v.string(),
    labelIds: v.array(v.string()),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddresses: v.array(v.string()),
    ccAddresses: v.array(v.string()),
    replyTo: v.optional(v.string()),
    subject: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    snippet: v.optional(v.string()),
    hasAttachments: v.boolean(),
    attachments: v.optional(
      v.array(
        v.object({
          filename: v.string(),
          mimeType: v.string(),
          sizeBytes: v.number(),
          storageId: v.optional(v.id("_storage")),
        }),
      ),
    ),
    listUnsubscribe: v.optional(v.string()),
    listUnsubscribePost: v.optional(v.string()),
    authResults: v.optional(
      v.object({ spf: v.string(), dkim: v.string(), dmarc: v.string() }),
    ),
    receivedAt: v.number(),
    rfcMessageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    referencesHeader: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("emailMessages")
      .withIndex("by_account_provider_id", (q) =>
        q.eq("accountId", args.accountId).eq("providerMessageId", args.providerMessageId),
      )
      .unique();

    if (existing) {
      // Labels are the one thing that legitimately changes on re-sync — a
      // message you moved out of SPAM, or that got a new label.
      await ctx.db.patch("emailMessages", existing._id, { labelIds: args.labelIds });
      return { emailMessageId: existing._id, created: false };
    }

    const emailMessageId = await ctx.db.insert("emailMessages", args);
    return { emailMessageId, created: true };
  },
});

export const recentForAccount = internalQuery({
  args: { accountId: v.id("connectedAccounts"), limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("emailMessages")
      .withIndex("by_account_received", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .take(Math.min(args.limit, 50));
  },
});

export const countForAccount = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, args) => {
    // Bounded on purpose: this is a "how is the sync doing" number for
    // /accounts, not an analytics aggregate. Phase 17 can add @convex-dev/aggregate.
    const rows = await ctx.db
      .query("emailMessages")
      .withIndex("by_account_received", (q) => q.eq("accountId", args.accountId))
      .take(501);
    return { count: rows.length, capped: rows.length > 500 };
  },
});

/**
 * Bounded substring search across one or more accounts' synced messages.
 *
 * This searches what sync has already stored — the 2-day window from
 * `convex/gmail.ts` — not a live Gmail API call. That is Phase 3's actual
 * scope: enough to answer "what's new" and "anything from X", not a general
 * mail search. Live search is a later-phase upgrade, not a bug fix.
 */
export const search = internalQuery({
  args: {
    accountIds: v.array(v.id("connectedAccounts")),
    query: v.optional(v.string()),
    /** Gmail's own labelIds entry, e.g. "SPAM". A literal filter, not a
     *  judgement — Phase 3 stores labels, it does not classify. */
    gmailLabel: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const needle = args.query?.trim().toLowerCase();
    const limit = Math.min(args.limit, 25);

    const perAccount: Array<Awaited<ReturnType<typeof fetchOne>>> = [];
    async function fetchOne(accountId: (typeof args.accountIds)[number]) {
      return await ctx.db
        .query("emailMessages")
        .withIndex("by_account_received", (q) => q.eq("accountId", accountId))
        .order("desc")
        .take(100);
    }
    for (const accountId of args.accountIds) perAccount.push(await fetchOne(accountId));

    const all = perAccount.flat().sort((a, b) => b.receivedAt - a.receivedAt);

    const byLabel = args.gmailLabel
      ? all.filter((m) => m.labelIds.includes(args.gmailLabel!))
      : all;

    const matched = needle
      ? byLabel.filter((m) =>
          [m.subject, m.fromAddress, m.fromName, m.snippet, m.bodyText]
            .filter(Boolean)
            .some((field) => field!.toLowerCase().includes(needle)),
        )
      : byLabel;

    return matched.slice(0, limit);
  },
});

/**
 * Resolve "that FairMoney email" / "the interview one" to a row, by sender or
 * subject substring, within an account's recently-seen mail.
 *
 * This exists because email ids are never shown in chat (an id in the middle
 * of a rendered list is noise), so a follow-up like "read me the full one
 * from FairMoney" has nothing to reference except what the conversation
 * itself remembers — a name, a subject fragment. Same pattern as
 * `tasks.findByTitle`: the model supplies words, the match happens in code.
 */
export const findByFragment = internalQuery({
  args: { accountIds: v.array(v.id("connectedAccounts")), fragment: v.string() },
  handler: async (ctx, args) => {
    const needle = args.fragment.trim().toLowerCase();
    if (!needle) return null;

    const perAccount: Array<Awaited<ReturnType<typeof fetchOne>>> = [];
    async function fetchOne(accountId: (typeof args.accountIds)[number]) {
      return await ctx.db
        .query("emailMessages")
        .withIndex("by_account_received", (q) => q.eq("accountId", accountId))
        .order("desc")
        .take(50);
    }
    for (const accountId of args.accountIds) perAccount.push(await fetchOne(accountId));

    const all = perAccount.flat().sort((a, b) => b.receivedAt - a.receivedAt);

    // Token matching, not a contiguous substring. A natural reference like
    // "FairMoney clinic replay" is not a substring of the actual subject
    // "Missed FairMoney Clinic? Catch the replay 🎧" — word order and filler
    // differ — so an `includes()` match silently found nothing and the
    // assistant answered from whatever it could still see instead.
    const tokens = needle.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length === 0) {
      return all.find((m) => (m.subject ?? "").toLowerCase().includes(needle)) ?? null;
    }

    let best: (typeof all)[number] | null = null;
    let bestScore = 0;
    for (const m of all) {
      const haystack = [m.subject, m.fromAddress, m.fromName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const score = tokens.filter((t) => haystack.includes(t)).length;
      // Newest-first ordering is preserved by only replacing on a STRICTLY
      // better score, so ties resolve to the most recent message.
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  },
});

export const getById = internalQuery({
  args: { emailMessageId: v.id("emailMessages") },
  handler: async (ctx, args) => await ctx.db.get("emailMessages", args.emailMessageId),
});
