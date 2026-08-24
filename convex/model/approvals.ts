import { internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { v } from "convex/values";
import { payloadHash, changesetPayloadHash, type ChangesetEntry } from "../security/hash";
import { recipientsContained } from "../lib/email/recipients";

const DEFAULT_TTL_MINUTES = 30;

function ttlMinutes(): number {
  const raw = process.env.APPROVAL_TTL_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MINUTES;
}

/**
 * The most recent approval for this exact (action, targetType, targetId), or
 * null. There should only ever be one LIVE one at a time — `create` does not
 * enforce that with a unique index (Convex has none), so this always resolves
 * ties by recency rather than assuming there are none.
 */
async function liveApprovalFor(
  ctx: QueryCtx | MutationCtx,
  action: string,
  targetType: string,
  targetId: string,
): Promise<Doc<"approvals"> | null> {
  const rows = await ctx.db
    .query("approvals")
    .withIndex("by_target", (q) => q.eq("targetType", targetType).eq("targetId", targetId))
    .collect();

  const matching = rows.filter((r) => r.action === action);
  matching.sort((a, b) => b._creationTime - a._creationTime);
  return matching[0] ?? null;
}

export const findLive = internalQuery({
  args: { action: v.string(), targetType: v.string(), targetId: v.string() },
  handler: async (ctx, args) => await liveApprovalFor(ctx, args.action, args.targetType, args.targetId),
});

/**
 * Opens the approval desk for one target. `email.create_draft` calls this
 * immediately after inserting a draft (Step 12) — the source plan's state
 * machine has DRAFT CREATED flow straight into APPROVAL PENDING with no gap
 * for the user to fall into. `executeToolCall`'s gate (Step 12) also calls
 * this as a fallback, for any consequential tool proposed with no earlier
 * step having opened one first.
 */
export const create = internalMutation({
  args: {
    userId: v.id("users"),
    action: v.string(),
    targetType: v.string(),
    targetId: v.string(),
    accountId: v.optional(v.id("connectedAccounts")),
    payloadHash: v.string(),
  },
  handler: async (ctx, args) => {
    const expiresAt = Date.now() + ttlMinutes() * 60_000;

    const approvalId = await ctx.db.insert("approvals", {
      userId: args.userId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      accountId: args.accountId,
      payloadHash: args.payloadHash,
      status: "PENDING",
      expiresAt,
    });

    const jobId = await ctx.scheduler.runAt(expiresAt, internal.model.approvals.expire, {
      approvalId,
    });
    await ctx.db.patch("approvals", approvalId, { expiryJobId: jobId });

    return { approvalId, expiresAt };
  },
});

/**
 * The scheduler's own target. Only expires a still-PENDING row — a CONSUMED
 * one that fired its `[Send]` tap moments before this runs must not be
 * clobbered back to a terminal-looking state.
 */
export const expire = internalMutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get("approvals", args.approvalId);
    if (!approval || approval.status !== "PENDING") return;

    await ctx.db.patch("approvals", args.approvalId, { status: "EXPIRED", decidedAt: Date.now() });
    await ctx.db.insert("auditLogs", {
      actor: "scheduler",
      action: "approval.expire",
      targetType: approval.targetType,
      targetId: approval.targetId,
      accountId: approval.accountId,
      approvalId: args.approvalId,
      args: {},
      result: "ok",
    });
  },
});

/** The safe direction. Cancels the expiry timer and marks REJECTED — used by
 *  the [Discard] button and by email.discard_draft. A no-op if nothing is
 *  live, which is the correct behaviour for discarding a draft that was
 *  never sent for approval in the first place. */
export const rejectForTarget = internalMutation({
  args: { action: v.string(), targetType: v.string(), targetId: v.string() },
  handler: async (ctx, args) => {
    const approval = await liveApprovalFor(ctx, args.action, args.targetType, args.targetId);
    if (!approval || approval.status !== "PENDING") return { rejected: false };

    if (approval.expiryJobId) await ctx.scheduler.cancel(approval.expiryJobId);
    await ctx.db.patch("approvals", approval._id, { status: "REJECTED", decidedAt: Date.now() });
    return { rejected: true };
  },
});

type ConsumeResult =
  // draftId is present only for the "drafts" target type. A Linear batch is
  // content-addressed and has no document to hand back, so the caller reads
  // its target id from the callback data it already holds.
  | { ok: true; approvalId: Id<"approvals">; draftId?: Id<"drafts"> }
  | { ok: false; reason: string };

/**
 * THE seven-check gate. Called ONLY from the [Send] button's handler
 * (convex/assistant.ts, Step 14) — by the time this returns ok:true, the
 * approval is already CONSUMED and `executeToolCall` (Step 12) only has to
 * confirm that and proceed. Every check below is one line of the state
 * machine diagram above.
 */
export const consume = internalMutation({
  args: { action: v.string(), targetType: v.string(), targetId: v.string() },
  handler: async (ctx, args): Promise<ConsumeResult> => {
    const approval = await liveApprovalFor(ctx, args.action, args.targetType, args.targetId);
    if (!approval) {
      return { ok: false, reason: "No approval found for this — it may already have been actioned." };
    }

    // check 1 — PENDING, and unexpired. A row past its expiresAt that the
    // scheduler hasn't gotten to yet (a race with its own runAt firing) is
    // treated as expired right here, not trusted to still be PENDING.
    if (approval.status !== "PENDING") {
      const reasons: Record<string, string> = {
        CONSUMED: "Already sent — this was a duplicate tap.",
        REJECTED: "This was already discarded.",
        EXPIRED: "This approval expired. Draft it again to get a new one.",
      };
      return { ok: false, reason: reasons[approval.status] ?? `Approval is ${approval.status}.` };
    }
    if (Date.now() >= approval.expiresAt) {
      await ctx.db.patch("approvals", approval._id, { status: "EXPIRED", decidedAt: Date.now() });
      return { ok: false, reason: "This approval expired. Draft it again to get a new one." };
    }

    // A Linear batch. Its target is content-addressed rather than a document
    // id, so "recompute from the live record" means re-hashing the stored
    // batch — same guarantee as the draft path below, reached differently.
    if (args.targetType === "linear_changesets") {
      const stored = await ctx.db
        .query("preferences")
        .withIndex("by_user_key", (q) =>
          q.eq("userId", approval.userId).eq("key", `linear_changeset:${args.targetId}`),
        )
        .first();
      if (!stored) {
        return { ok: false, reason: "That batch is no longer available. Propose it again." };
      }

      const changes = (stored.value as { changes: ChangesetEntry[] }).changes;
      const liveHash = await changesetPayloadHash(changes);
      if (liveHash !== approval.payloadHash) {
        return {
          ok: false,
          reason: "That batch changed after it was approved. Propose it again to re-approve.",
        };
      }

      await ctx.db.patch("approvals", approval._id, {
        status: "CONSUMED",
        decidedAt: Date.now(),
      });
      return { ok: true, approvalId: approval._id };
    }

    if (args.targetType !== "drafts") {
      // Phase 8 adds a branch here for archive/trash/forward/unsubscribe,
      // each with its own live-target shape to recompute a hash from.
      throw new Error(`approvals.consume: unsupported targetType "${args.targetType}"`);
    }

    const draftId = ctx.db.normalizeId("drafts", args.targetId);
    if (!draftId) return { ok: false, reason: "Malformed draft reference." };
    const draft = await ctx.db.get("drafts", draftId);
    if (!draft) return { ok: false, reason: "That draft no longer exists." };

    const message = await ctx.db.get("emailMessages", draft.emailMessageId);
    if (!message) return { ok: false, reason: "The original email is gone." };

    // check 2 — recompute the hash from the LIVE draft, never from a copy.
    const liveHash = await payloadHash({
      accountId: draft.accountId,
      anchorId: draft.emailMessageId,
      inReplyTo: draft.inReplyTo,
      to: draft.toAddresses,
      cc: draft.ccAddresses,
      subject: draft.subject,
      body: draft.bodyText,
      attachmentFileIds: draft.attachmentFileIds,
    });
    if (liveHash !== approval.payloadHash) {
      return { ok: false, reason: "This draft changed after it was approved. Send it again to re-approve." };
    }

    // check 3 — invariant I-3, enforced in code, not inferred.
    if (draft.accountId !== message.accountId) {
      await ctx.db.insert("auditLogs", {
        actor: "system",
        action: "approval.account_mismatch",
        targetType: "drafts",
        targetId: draftId,
        accountId: draft.accountId,
        approvalId: approval._id,
        args: { messageAccountId: message.accountId },
        result: "denied",
      });
      return { ok: false, reason: "Account mismatch — refusing to send from the wrong mailbox." };
    }

    // check 4 — recipient containment (adversarial #9).
    const recipients = [...draft.toAddresses, ...draft.ccAddresses];
    const contained = recipientsContained(recipients, {
      from: message.fromAddress,
      to: message.toAddresses,
      cc: message.ccAddresses,
      replyTo: message.replyTo,
    });
    if (!contained) {
      await ctx.db.insert("auditLogs", {
        actor: "system",
        action: "approval.recipient_not_in_thread",
        targetType: "drafts",
        targetId: draftId,
        accountId: draft.accountId,
        approvalId: approval._id,
        args: { recipients },
        result: "denied",
      });
      return {
        ok: false,
        reason: "This reply has a recipient not in the original thread. Confirm the new address by name before I can send it.",
      };
    }

    // check 5 — CONSUMED before the connector is ever touched. Cancel the
    // expiry timer too; there is nothing left for it to expire.
    if (approval.expiryJobId) await ctx.scheduler.cancel(approval.expiryJobId);
    await ctx.db.patch("approvals", approval._id, { status: "CONSUMED", decidedAt: Date.now() });

    // check 6 — the audit row. Written here, inside this transaction, so it
    // exists even if the connector call that follows (an ACTION, outside
    // this transaction) fails outright.
    await ctx.db.insert("auditLogs", {
      actor: "user",
      action: "approval.consume",
      targetType: "drafts",
      targetId: draftId,
      accountId: draft.accountId,
      approvalId: approval._id,
      args: { to: draft.toAddresses, cc: draft.ccAddresses, payloadHash: liveHash },
      result: "ok",
    });

    // check 7 is not a runtime check — it's a property of the code: nothing
    // above (or anywhere else in this phase) reads AUTONOMOUS_SEND_ENABLED,
    // because the variable does not exist yet. See docs/ENV.md.

    return { ok: true, approvalId: approval._id, draftId };
  },
});
