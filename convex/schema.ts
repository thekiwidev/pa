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
    accountId: v.optional(v.id("connectedAccounts")),
    approvalId: v.optional(v.id("approvals")),
    args: v.any(), // secrets redacted BEFORE insert
    result: v.union(v.literal("ok"), v.literal("denied"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    autonomous: v.optional(v.boolean()), // Phase 18
  })
    .index("by_action", ["action"])
    .index("by_account", ["accountId"]),

  // ── Phase 1 ────────────────────────────────────────────────
  messages: defineTable({
    userId: v.id("users"),
    channel: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    channelMessageId: v.optional(v.string()),
    kind: v.string(), // text | voice | document | photo
    text: v.optional(v.string()),
    mediaRef: v.optional(
      v.object({
        storageId: v.optional(v.id("_storage")),
        mimeType: v.string(),
        sizeBytes: v.number(),
      }),
    ),
    transcript: v.optional(v.string()), // Phase 9
    transcriptConfidence: v.optional(v.number()), // Phase 9
  }).index("by_user", ["userId"]),

  // ── Phase 2 ────────────────────────────────────────────────
  projects: defineTable({
    userId: v.id("users"),
    name: v.string(),
    status: v.string(), // ACTIVE | PAUSED | DONE
    objective: v.optional(v.string()),
    context: v.optional(v.any()),
    priority: v.number(),
  }).index("by_user_name", ["userId", "name"]),

  people: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    emails: v.array(v.string()),
    importance: v.string(), // CRITICAL | HIGH | NORMAL | LOW
    notes: v.optional(v.any()),
  })
    .index("by_user", ["userId"])
    .index("by_email", ["emails"]), // array index: matches any element

  tasks: defineTable({
    userId: v.id("users"),
    projectId: v.optional(v.id("projects")),
    title: v.string(),
    detail: v.optional(v.string()),
    status: v.string(), // PLANNED|IN_PROGRESS|BLOCKED|WAITING|RESUMED|COMPLETED|CANCELLED
    priority: v.number(),
    dueAt: v.optional(v.number()), // ms epoch
    sourceType: v.optional(v.string()), // telegram | email | calendar | meeting
    sourceRef: v.optional(v.string()),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_user_due", ["userId", "dueAt"])
    .index("by_project", ["projectId"]),

  blockers: defineTable({
    taskId: v.id("tasks"),
    description: v.string(),
    waitingOn: v.optional(v.id("people")),
    expectedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_expected", ["resolvedAt", "expectedAt"]),

  reminders: defineTable({
    userId: v.id("users"),
    message: v.string(),
    scheduledAt: v.number(),
    status: v.string(), // PENDING | SENT | CANCELLED
    scheduledJobId: v.optional(v.id("_scheduled_functions")), // for cancel/reschedule
    taskId: v.optional(v.id("tasks")),
    projectId: v.optional(v.id("projects")),
    sentAt: v.optional(v.number()),
  }).index("by_status_scheduled", ["status", "scheduledAt"]),

  preferences: defineTable({
    userId: v.id("users"),
    key: v.string(),
    value: v.any(),
  }).index("by_user_key", ["userId", "key"]),

  /**
   * Not in the build plan — added on direct request. Free-form behavioural
   * rules the user teaches the assistant via chat ("always ask before X",
   * "keep replies under two sentences"), rendered into the planning prompt.
   *
   * A dedicated table rather than one growing array field on a preferences
   * document, per the schema guideline against unbounded arrays in a single
   * document. Bounded to CUSTOM_INSTRUCTIONS_MAX in the model layer.
   */
  customInstructions: defineTable({
    userId: v.id("users"),
    text: v.string(),
  }).index("by_user", ["userId"]),

  /**
   * Not in the build plan — added on direct request. Facts ABOUT the owner
   * that tailor every reply: role, qualifications, preferences, vocabulary.
   *
   * Distinct from customInstructions (rules for how to behave) and skills
   * (procedures for one capability). Rendered into every planning prompt, so
   * bounded by MAX_CONTEXT_ENTRIES in convex/lib/userContext.ts.
   */
  userContext: defineTable({
    userId: v.id("users"),
    category: v.string(), // see CONTEXT_CATEGORIES
    text: v.string(),
  }).index("by_user_category", ["userId", "category"]),

  /**
   * Not in the build plan — added on direct request. A named, full-authority
   * procedure for one capability ("morning_brief", "check_email",
   * "draft_reply") — unlike customInstructions, which are small tone/workflow
   * rules rendered on every message, a skill is loaded only when its domain
   * is relevant (keyword-matched, see lib/skills.ts) and can specify an
   * actual multi-step procedure including which tools to use and in what
   * order. This does NOT widen what the assistant can do — a skill still
   * cannot talk the router into executing a consequential tool without a
   * real approval; that gate is enforced in code (tools/router.ts), not by
   * anything in a prompt. A skill with no row here falls back to a built-in
   * default (lib/skills.ts's DEFAULT_SKILLS) so the feature is useful before
   * the user has written anything.
   */
  skills: defineTable({
    userId: v.id("users"),
    name: v.string(), // stable slug: "morning_brief" | "check_email" | "draft_reply" | ...
    title: v.string(),
    content: v.string(), // markdown; may reference another skill via {{skill:name}}
  }).index("by_user_name", ["userId", "name"]),

  // ── Phase 3 ────────────────────────────────────────────────
  /**
   * One-time, expiring OAuth handshake tokens.
   *
   * The nonce IS the authorization: /oauth/google/start refuses to redirect
   * without a live row, so the flow can only be begun from a link this
   * deployment minted for the owner in Telegram. The callback consumes the row
   * atomically, which is what makes it single-use.
   */
  oauthStates: defineTable({
    nonce: v.string(),
    userId: v.id("users"),
    provider: v.string(), // google
    label: v.string(), // recruiting | personal | client
    expiresAt: v.number(),
    /** Set when re-authorizing an existing account rather than adding one. */
    reconnectAccountId: v.optional(v.id("connectedAccounts")),
  }).index("by_nonce", ["nonce"]),

  connectedAccounts: defineTable({
    userId: v.id("users"),
    provider: v.string(), // gmail | zoho | outlook | google_calendar | google_drive
    accountEmail: v.string(),
    displayName: v.string(),
    label: v.string(), // recruiting | personal | client
    status: v.string(), // ACTIVE | NEEDS_REAUTH | REVOKED
    encryptedCredentials: v.bytes(), // AES-256-GCM via Web Crypto
    credentialIv: v.bytes(),
    credentialAuthTag: v.bytes(),
    scopesGranted: v.array(v.string()),
    lastHistoryId: v.optional(v.string()), // Phase 8
    watchExpiresAt: v.optional(v.number()), // Phase 8
    lastSyncedAt: v.optional(v.number()),
    priorityRules: v.optional(v.any()), // Phase 7
  })
    .index("by_user_provider", ["userId", "provider"])
    .index("by_label", ["label"])
    .index("by_status", ["status"]),

  emailMessages: defineTable({
    accountId: v.id("connectedAccounts"),
    providerMessageId: v.string(),
    threadId: v.string(),
    labelIds: v.array(v.string()), // contains "SPAM" when applicable
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddresses: v.array(v.string()),
    ccAddresses: v.array(v.string()),
    replyTo: v.optional(v.string()),
    subject: v.optional(v.string()),
    bodyText: v.optional(v.string()), // CAP AT 32 KB — bandwidth, not storage
    bodyStorageId: v.optional(v.id("_storage")), // overflow + raw MIME
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
      v.object({
        spf: v.string(),
        dkim: v.string(),
        dmarc: v.string(),
      }),
    ),
    receivedAt: v.number(),
    rfcMessageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    referencesHeader: v.optional(v.string()),
    // Phase 4
    importance: v.optional(v.string()), // CRITICAL|HIGH|NORMAL|LOW|IGNORE
    classification: v.optional(v.any()),
    classifiedAt: v.optional(v.number()),
    classifierVersion: v.optional(v.string()),
    processedAt: v.optional(v.number()),
  })
    .index("by_account_provider_id", ["accountId", "providerMessageId"]) // uniqueness
    .index("by_account_received", ["accountId", "receivedAt"])
    .index("by_thread", ["threadId"])
    .index("by_importance_processed", ["importance", "processedAt"]),

  // ── Phase 4 ────────────────────────────────────────────────
  noiseSenders: defineTable({
    userId: v.id("users"),
    pattern: v.string(), // exact address or domain
  }).index("by_user_pattern", ["userId", "pattern"]),

  // ── Phase 5 ────────────────────────────────────────────────
  notifications: defineTable({
    userId: v.id("users"),
    channel: v.string(),
    emailMessageId: v.optional(v.id("emailMessages")),
    threadKey: v.optional(v.string()), // dedup
    channelMessageId: v.optional(v.string()), // to EDIT the card in place
    payload: v.any(),
    sentAt: v.number(),
  }).index("by_thread_key", ["threadKey"]),

  feedback: defineTable({
    userId: v.id("users"),
    emailMessageId: v.id("emailMessages"),
    predicted: v.string(),
    corrected: v.string(),
  }).index("by_user", ["userId"]),

  // ── Phase 6 ────────────────────────────────────────────────
  drafts: defineTable({
    emailMessageId: v.id("emailMessages"),
    accountId: v.id("connectedAccounts"), // MUST equal source message accountId
    toAddresses: v.array(v.string()),
    ccAddresses: v.array(v.string()),
    subject: v.string(),
    bodyText: v.string(),
    inReplyTo: v.optional(v.string()),
    referencesHeader: v.optional(v.string()),
    attachmentFileIds: v.optional(v.array(v.string())), // Phase 11, in payloadHash
    status: v.string(), // DRAFT|PENDING_APPROVAL|SENT|DISCARDED|FAILED
    version: v.number(),
  })
    .index("by_message", ["emailMessageId"])
    .index("by_status", ["status"]),

  approvals: defineTable({
    userId: v.id("users"),
    action: v.string(), // email.send | email.forward | calendar.create | ...
    targetType: v.string(),
    targetId: v.string(),
    accountId: v.optional(v.id("connectedAccounts")),
    payloadHash: v.string(),
    status: v.string(), // PENDING|CONSUMED|REJECTED|EXPIRED
    expiresAt: v.number(),
    expiryJobId: v.optional(v.id("_scheduled_functions")),
    decidedAt: v.optional(v.number()),
  })
    .index("by_status_expiry", ["status", "expiresAt"])
    .index("by_target", ["targetType", "targetId"]),

  // ── Phase 8 ────────────────────────────────────────────────
  syncCursors: defineTable({
    accountId: v.id("connectedAccounts"),
    lastHistoryId: v.optional(v.string()),
    lastFullSyncAt: v.optional(v.number()),
    lastPushAt: v.optional(v.number()),
    consecutiveFailures: v.number(),
  }).index("by_account", ["accountId"]),

  webhookEvents: defineTable({
    source: v.string(), // gmail_pubsub | telegram
    externalId: v.string(), // idempotency key
    payload: v.any(),
    processedAt: v.optional(v.number()),
  }).index("by_external_id", ["externalId"]),

  // ── Phase 13 ───────────────────────────────────────────────
  dailyFocus: defineTable({
    userId: v.id("users"),
    date: v.string(), // "2026-08-19" in USER_TIMEZONE
    mainObjective: v.string(),
    supportingTaskIds: v.array(v.id("tasks")),
    fallbackTaskIds: v.array(v.id("tasks")),
    revisedAt: v.optional(v.number()),
  }).index("by_user_date", ["userId", "date"]),

  // ── Phase 17 — ONLY past the measured trigger ──────────────
  memories: defineTable({
    userId: v.id("users"),
    kind: v.string(), // episodic|semantic|relationship|preference|project|working
    text: v.string(),
    projectId: v.optional(v.id("projects")),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_user_kind", ["userId", "kind"])
    .searchIndex("search_text", {
      // try THIS before vectors
      searchField: "text",
      filterFields: ["userId", "kind"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768, // match your EMBED-tier model
      filterFields: ["userId", "kind"],
    }),
});
