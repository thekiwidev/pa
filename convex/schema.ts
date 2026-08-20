// Phase 0 tables only. Add tables as their phase arrives —
// the full target schema is Appendix F of the v3 build plan.
//
// Convex has no Date type: store ms-epoch numbers and format at the edge.
// Convex has no UNIQUE constraint: enforce uniqueness with an index plus a
// check-then-insert inside a single mutation (mutations are transactions).
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ── Phase 0 ────────────────────────────────────────────────
  users: defineTable({
    telegramId: v.string(),
    displayName: v.string(),
    timezone: v.string(), // "Africa/Lagos"
  }).index("by_telegram", ["telegramId"]),

  // Append-only. Nothing deletes from this table, ever.
  // See convex/model/audit.ts — there is deliberately no delete function.
  auditLogs: defineTable({
    actor: v.union(
      v.literal("user"),
      v.literal("system"),
      v.literal("scheduler"),
      v.literal("llm_proposed"),
    ),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    args: v.any(), // secrets redacted BEFORE insert
    result: v.union(v.literal("ok"), v.literal("denied"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
  })
    .index("by_action", ["action"]),
});
