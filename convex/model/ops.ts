import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { scrubSecrets, shouldAlert, type Severity } from "../lib/ops/incident";

/**
 * Record one occurrence and decide, inside the same transaction, whether it
 * pages. Deciding here (not in the action) is what stops two failures in the
 * same second from both sending an alert.
 */
export const recordIncident = internalMutation({
  args: {
    fingerprint: v.string(),
    source: v.string(),
    severity: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const sample = scrubSecrets(args.message).slice(0, 500);
    const existing = await ctx.db
      .query("opsIncidents")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", args.fingerprint))
      .unique();

    if (!existing) {
      const alert = shouldAlert(null, args.severity as Severity, now);
      await ctx.db.insert("opsIncidents", {
        fingerprint: args.fingerprint,
        source: args.source,
        severity: args.severity,
        sample,
        count: 1,
        countSinceDigest: 1,
        firstAt: now,
        lastAt: now,
        ...(alert ? { lastAlertAt: now } : {}),
      });
      return { alert, count: 1, firstAt: now };
    }

    // A failure that had stopped and came back is a fresh episode.
    const reopened = existing.resolvedAt !== undefined;
    const alert = shouldAlert(
      reopened ? { mutedUntil: existing.mutedUntil } : existing,
      args.severity as Severity,
      now,
    );
    await ctx.db.patch(existing._id, {
      sample,
      severity: args.severity,
      count: reopened ? 1 : existing.count + 1,
      countSinceDigest: existing.countSinceDigest + 1,
      firstAt: reopened ? now : existing.firstAt,
      lastAt: now,
      resolvedAt: undefined,
      ...(alert ? { lastAlertAt: now } : {}),
    });
    return {
      alert,
      count: reopened ? 1 : existing.count + 1,
      firstAt: reopened ? now : existing.firstAt,
    };
  },
});

/** A source that just worked again closes its open incidents. */
export const resolveSource = internalMutation({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("opsIncidents")
      .withIndex("by_last", (q) => q.gt("lastAt", Date.now() - 7 * 24 * 60 * 60 * 1000))
      .take(200);
    let closed = 0;
    for (const row of recent) {
      if (row.source === args.source && row.resolvedAt === undefined) {
        await ctx.db.patch(row._id, { resolvedAt: Date.now() });
        closed++;
      }
    }
    return { closed };
  },
});

export const mute = internalMutation({
  args: { fingerprint: v.string(), hours: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("opsIncidents")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", args.fingerprint))
      .unique();
    if (!row) return { muted: false };
    await ctx.db.patch(row._id, { mutedUntil: Date.now() + args.hours * 60 * 60 * 1000 });
    return { muted: true, source: row.source };
  },
});

export const get = internalQuery({
  args: { fingerprint: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("opsIncidents")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", args.fingerprint))
      .unique(),
});

/** Incidents seen since `sinceMs`, newest first. */
export const recent = internalQuery({
  args: { sinceMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db
      .query("opsIncidents")
      .withIndex("by_last", (q) => q.gt("lastAt", args.sinceMs))
      .order("desc")
      .take(args.limit ?? 50),
});

/** Called after the digest goes out. */
export const resetDigestCounts = internalMutation({
  args: { ids: v.array(v.id("opsIncidents")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) await ctx.db.patch(id, { countSinceDigest: 0 });
  },
});
