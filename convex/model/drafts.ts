import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
    emailMessageId: v.id("emailMessages"),
    accountId: v.id("connectedAccounts"),
    toAddresses: v.array(v.string()),
    ccAddresses: v.array(v.string()),
    subject: v.string(),
    bodyText: v.string(),
    inReplyTo: v.optional(v.string()),
    referencesHeader: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const draftId = await ctx.db.insert("drafts", {
      ...args,
      status: "DRAFT",
      version: 1,
    });
    return { draftId };
  },
});

export const get = internalQuery({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => await ctx.db.get("drafts", args.draftId),
});

/**
 * Not wired to a tool yet in this phase — no `email.update_draft` exists in
 * the catalog. It exists so a future "actually say X instead" flow can patch
 * a draft in place rather than discard-and-recreate, and so its shape is
 * settled before anything depends on it. Bumping `version` is a hygiene trail
 * for the dashboard; the hash mismatch in `approvals.consume` is what
 * actually enforces that an edit voids a pending approval, independent of
 * whether `version` is ever read anywhere.
 */
export const update = internalMutation({
  args: {
    draftId: v.id("drafts"),
    toAddresses: v.optional(v.array(v.string())),
    ccAddresses: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    bodyText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { draftId, ...patch } = args;
    const draft = await ctx.db.get("drafts", draftId);
    if (!draft) throw new Error("no such draft");

    await ctx.db.patch("drafts", draftId, { ...patch, version: draft.version + 1 });
    return { draftId, version: draft.version + 1 };
  },
});

export const discard = internalMutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get("drafts", args.draftId);
    if (!draft) return { discarded: false };

    await ctx.db.patch("drafts", args.draftId, { status: "DISCARDED" });
    return { discarded: true };
  },
});

export const markSent = internalMutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    await ctx.db.patch("drafts", args.draftId, { status: "SENT" });
  },
});

/** Called only from gmail.sendReply's own catch block — see Step 10. The
 *  approval is already CONSUMED by this point; this just makes the failure
 *  visible on the draft itself instead of leaving it looking like it's still
 *  in flight. */
export const markFailed = internalMutation({
  args: { draftId: v.id("drafts"), reason: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch("drafts", args.draftId, { status: "FAILED" });
  },
});
