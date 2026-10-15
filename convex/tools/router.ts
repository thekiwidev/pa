import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { TOOL_META } from "../lib/tools/catalog";
import type { ToolCall } from "../lib/tools/plan";
import { toEpochMs, formatInstant } from "../lib/time";
import { normalizeCategory } from "../lib/userContext";
import { sendCard, sendMessage } from "../channels/telegram";

/** Room for the envelope chrome inside Telegram's 4096-char message cap.
 *  Past this the body is sent as its own (splittable) message and the card
 *  just carries the buttons. */
const CARD_BODY_LIMIT = 3600;
import { alreadyHtml, escapeTelegramHtml } from "../lib/telegram/html";
import { BODY_OUTPUT_CONTRACT, extractDraftBody } from "../lib/email/draftBody";
import { describeRule, normalizePattern, type RuleAction } from "../lib/email/rules";
import { buildGmailQuery, searchWindow } from "../lib/email/gmailQuery";
import {
  listEvents,
  getEvent,
  createEvent,
  type CalendarEvent,
} from "../connectors/gcal/client";
import { resolveWindow } from "../lib/calendar/window";
import {
  checkAvailability,
  NEARBY_MARGIN_MS,
  type CalendarItem,
} from "../lib/calendar/availability";
import {
  searchFiles,
  getFile,
  exportFileText,
  downloadFileText,
  type DriveFile,
} from "../connectors/gdrive/client";
import { buildDriveQuery, planRead, fileKind } from "../lib/drive/query";
import {
  normalizeBatch,
  renderBatchMarkdown,
  describeBatch,
  type CaptureDestination,
  type CaptureItem,
} from "../lib/capture/batch";
import {
  whenToMs,
  displayEndMs,
  isAllDay,
  otherAttendees,
  affectsOthers,
  findFreeSlots,
} from "../lib/calendar/events";
import {
  backendForAccounts,
  matchLabels,
  resolveStateForStatus,
  resolveStateByName,
  stateTypesForFilter,
  statusForStateType,
  linearPriorityForInternal,
  linearDueDate,
  withBlockerNote,
  withoutBlockerNote,
  type TaskStatus,
} from "../lib/tasks/backend";
import { detectPlatform, extractUrls } from "../lib/social/detect";
import { ingestLink, searchSaved, toView } from "../saved";
import { parseNotionLists, resolveListName } from "../lib/notion/lists";
import { captureKey } from "../lib/capture/batch";
import {
  NotionUnavailable,
  addListRows,
  createNote,
  findNote,
  listCategories,
  markListRowFinished,
  queryList,
  readNote,
  searchNotes,
} from "../connectors/notion/client";
import {
  changesetIdFromHash,
  changesetPayloadHash,
  calendarEventPayloadHash,
  captureBatchPayloadHash,
  type ChangesetEntry,
  type CalendarEventEntry,
  type CaptureBatchEntry,
} from "../security/hash";
import { open } from "../security/crypto";
import {
  listIssues,
  listAllIssues,
  OPEN_STATE_TYPES,
  getIssue,
  listWorkflowStates,
  applyChangeset,
  listTeams,
  listLabels,
  createLabel,
  createIssues,
  searchIssues,
  type LinearIssueCreate,
  type LinearIssueSummary,
  type LinearIssueChange,
  LinearApiError,
} from "../connectors/linear/client";
import { cleanLinearKey, LINEAR_RECONNECT_HINT } from "../lib/linear/apiKey";
import { payloadHash } from "../security/hash";
import { runTask } from "../ai/registry";
import type { ToolOutcome } from "../lib/tools/outcomes";

/**
 * The application half of invariant I-1. The model proposed; this disposes.
 *
 * By the time a call reaches here it has already been Zod-validated by
 * parseToolPlan, so this function's remaining jobs are:
 *   1. refuse anything consequential without an approval (I-4)
 *   2. resolve names to ids deterministically — never let the model supply a
 *      foreign key it invented (I-3 in miniature)
 *   3. execute
 *   4. write an auditLogs row either way (I-5)
 */

export type { ToolOutcome };

export interface ToolContext {
  userId: Id<"users">;
  timezone: string;
  /**
   * Linear writes proposed by task.* during THIS turn, awaiting one approval.
   *
   * Why an accumulator rather than each tool writing directly: a Linear issue
   * is external, so writing one is consequential (I-4) and needs a typed,
   * expiring, single-use approval. But `meta.consequential` is static and
   * read before dispatch, and task.create is NOT consequential when the
   * backend is Convex — the same tool cannot be both.
   *
   * So on the Linear backend task.* does what linear.propose_changeset does:
   * it stages, and touches nothing. The caller flushes the batch into one
   * approval card after the tool loop, which also means "add three tasks and
   * close ENG-12" costs one tap rather than four.
   */
  staged?: StagedWrite[];
}

/** A staged Linear write plus the line describing it on the approval card. */
export interface StagedWrite {
  entry: ChangesetEntry;
  display: string;
}

export async function executeToolCall(
  ctx: ActionCtx,
  toolCtx: ToolContext,
  call: ToolCall,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const meta = TOOL_META[call.name];

  if (meta.consequential) {
    const target = targetFor(call);
    if (!target) {
      await audit(ctx, call, "denied", startedAt, "consequential tool call is missing its target");
      return { name: call.name, ok: false, result: { error: "Missing the id this action applies to." } };
    }

    const live = await ctx.runQuery(internal.model.approvals.findLive, {
      action: call.name,
      targetType: target.targetType,
      targetId: target.targetId,
    });

    if (!live || live.status === "PENDING") {
      // Nothing has consumed this yet. NEVER execute here — either wait for
      // the approval already pending (opened by whatever created the
      // target, e.g. email.create_draft below), or open one now as the
      // fallback for a consequential tool proposed with no earlier step.
      let approvalId = live?._id;
      let expiresAt = live?.expiresAt;
      if (!live) {
        const created = await createFallbackApproval(ctx, toolCtx.userId, call.name, target);
        approvalId = created.approvalId;
        expiresAt = created.expiresAt;
      }

      const accountId = await accountIdForTarget(ctx, target);
      await audit(ctx, call, "denied", startedAt, "consequential tool without a consumed approval", accountId, approvalId);
      return {
        name: call.name,
        ok: false,
        result: {
          awaitingApproval: true,
          expiresAt: expiresAt === undefined ? undefined : formatInstant(expiresAt, toolCtx.timezone),
        },
      };
    }

    if (live.status !== "CONSUMED") {
      const accountId = await accountIdForTarget(ctx, target);
      await audit(ctx, call, "denied", startedAt, `approval ${live.status.toLowerCase()}`, accountId, live._id);
      return { name: call.name, ok: false, result: { error: `That approval is ${live.status.toLowerCase()}.` } };
    }

    // CONSUMED — the [Send] tap already ran the seven checks in
    // approvals.consume. Fall through to dispatch, which performs the send.
  }

  try {
    const result = await dispatch(ctx, toolCtx, call);
    await audit(ctx, call, "ok", startedAt);
    return { name: call.name, ok: true, result };
  } catch (error) {
    const message =
      error instanceof LinearApiError && error.isAuthFailure
        ? LINEAR_RECONNECT_HINT
        : error instanceof Error
          ? error.message
          : String(error);
    await audit(ctx, call, "error", startedAt, message);
    // Connection-level failures are the owner's to fix and do not heal on
    // their own, so they page (rate-limited) on top of the inline reply.
    // Ordinary "no such issue" errors do not.
    const connectionFailure =
      (error instanceof LinearApiError && (error.isAuthFailure || error.status >= 500)) ||
      error instanceof NotionUnavailable;
    if (connectionFailure) {
      await ctx.scheduler.runAfter(0, internal.ops.report, {
        source: call.name.startsWith("note.") ? "notion" : `linear:${call.name}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { name: call.name, ok: false, result: { error: message } };
  }
}

/** Which (action, targetType, targetId) a consequential call resolves to.
 *  Phase 8 adds a case here for each of archive/trash/forward/unsubscribe,
 *  unchanged elsewhere. */
function targetFor(call: ToolCall): { targetType: string; targetId: string } | null {
  switch (call.name) {
    case "email.send_reply": {
      const draftId = call.args.draftId;
      return typeof draftId === "string" && draftId.length > 0
        ? { targetType: "drafts", targetId: draftId }
        : null;
    }
    case "linear.apply_changeset": {
      // Only a changesetId addresses a batch. The catalogue no longer accepts
      // raw `changes` here: an approval must exist BEFORE apply is reached,
      // and only linear.propose_changeset can open one, so "propose and apply
      // in the same breath" was never actually reachable through the gate.
      const changesetId = call.args.changesetId;
      return typeof changesetId === "string" && changesetId.length > 0
        ? { targetType: "linear_changesets", targetId: changesetId }
        : null;
    }
    case "capture.apply": {
      const batchId = call.args.batchId;
      return typeof batchId === "string" && batchId.length > 0
        ? { targetType: "capture_batches", targetId: batchId }
        : null;
    }
    case "calendar.apply_event": {
      const eventDraftId = call.args.eventDraftId;
      return typeof eventDraftId === "string" && eventDraftId.length > 0
        ? { targetType: "calendar_events", targetId: eventDraftId }
        : null;
    }
    default:
      return null;
  }
}

/** The fallback path: a consequential tool was proposed with no earlier step
 *  having opened an approval for its target yet. Only "drafts" has a known
 *  hash strategy this phase. */
async function createFallbackApproval(
  ctx: ActionCtx,
  userId: Id<"users">,
  action: string,
  target: { targetType: string; targetId: string },
): Promise<{ approvalId: Id<"approvals">; expiresAt: number }> {
  if (target.targetType === "linear_changesets") {
    const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
    const stored = rows.find((p) => p.key === `linear_changeset:${target.targetId}`);
    if (!stored) throw new Error("that batch is no longer available — propose it again");

    const changes = (stored.value as { changes: LinearIssueChange[] }).changes;
    return await ctx.runMutation(internal.model.approvals.create, {
      userId,
      action,
      targetType: target.targetType,
      targetId: target.targetId,
      payloadHash: await changesetPayloadHash(changes),
    });
  }

  if (target.targetType === "capture_batches") {
    const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
    const stored = rows.find((p) => p.key === `capture_batch:${target.targetId}`);
    if (!stored) throw new Error("that list is no longer pending — ask for it again");

    const batch = (stored.value as { batch: CaptureBatchEntry }).batch;
    return await ctx.runMutation(internal.model.approvals.create, {
      userId,
      action,
      targetType: target.targetType,
      targetId: target.targetId,
      payloadHash: await captureBatchPayloadHash(batch),
    });
  }

  if (target.targetType === "calendar_events") {
    const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
    const stored = rows.find((p) => p.key === `calendar_event:${target.targetId}`);
    if (!stored) throw new Error("that event is no longer pending — ask for it again");

    const event = (stored.value as { event: CalendarEventEntry }).event;
    return await ctx.runMutation(internal.model.approvals.create, {
      userId,
      action,
      targetType: target.targetType,
      targetId: target.targetId,
      payloadHash: await calendarEventPayloadHash(event),
    });
  }

  if (target.targetType !== "drafts") {
    throw new Error(`no hash strategy for target type "${target.targetType}" yet`);
  }
  const draft = await ctx.runQuery(internal.model.drafts.get, {
    draftId: target.targetId as Id<"drafts">,
  });
  if (!draft) throw new Error("draft not found");

  const hash = await payloadHash({
    accountId: draft.accountId,
    anchorId: draft.emailMessageId,
    inReplyTo: draft.inReplyTo,
    to: draft.toAddresses,
    cc: draft.ccAddresses,
    subject: draft.subject,
    body: draft.bodyText,
    attachmentFileIds: draft.attachmentFileIds,
  });

  return await ctx.runMutation(internal.model.approvals.create, {
    userId,
    action,
    targetType: target.targetType,
    targetId: target.targetId,
    accountId: draft.accountId,
    payloadHash: hash,
  });
}

async function accountIdForTarget(
  ctx: ActionCtx,
  target: { targetType: string; targetId: string },
): Promise<Id<"connectedAccounts"> | undefined> {
  if (target.targetType !== "drafts") return undefined;
  const draft = await ctx.runQuery(internal.model.drafts.get, {
    draftId: target.targetId as Id<"drafts">,
  });
  return draft?.accountId;
}

async function audit(
  ctx: ActionCtx,
  call: ToolCall,
  result: "ok" | "denied" | "error",
  startedAt: number,
  errorMessage?: string,
  accountId?: Id<"connectedAccounts">,
  approvalId?: Id<"approvals">,
) {
  await ctx.runMutation(internal.model.audit.record, {
    actor: "llm_proposed",
    action: call.name,
    args: call.args,
    result,
    errorMessage: errorMessage?.slice(0, 500),
    latencyMs: Date.now() - startedAt,
    accountId,
    approvalId,
  });
}

/**
 * Turn `{ taskId? , taskTitle? }` into a concrete id.
 *
 * Titles are resolved through a query, in code — never by handing the model's
 * string to a mutation and hoping. A title that matches nothing is an error
 * the user sees, not a silently skipped action.
 */
/**
 * An email from either a Convex id or a human fragment.
 *
 * `normalizeId` returns null for anything that is not an id for this table —
 * which is exactly what a Gmail message id, or an id the model invented,
 * looks like. Without this check that string reaches the mutation validator
 * and the user sees a raw ArgumentValidationError.
 */
async function resolveEmailMessage(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: Record<string, unknown>,
) {
  const raw = args.emailMessageId;
  if (typeof raw === "string" && raw.length > 0) {
    const normalized = await ctx.runQuery(internal.model.emailMessages.normalize, { id: raw });
    if (normalized) {
      return await ctx.runQuery(internal.model.emailMessages.getById, {
        emailMessageId: normalized,
      });
    }
    // Not a Convex id — fall through and treat it as a fragment rather than
    // failing, since a Gmail id often still contains nothing searchable.
  }

  const fragment =
    typeof args.senderOrSubject === "string" && args.senderOrSubject.length > 0
      ? args.senderOrSubject
      : undefined;
  if (!fragment) return null;

  const accountIds = await resolveAccountIds(ctx, userId, args.accountLabel);
  return await ctx.runQuery(internal.model.emailMessages.findByFragment, {
    accountIds,
    fragment,
  });
}

async function resolveTaskId(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: Record<string, unknown>,
): Promise<string> {
  if (typeof args.taskId === "string" && args.taskId.length > 0) return args.taskId;

  const title = args.taskTitle;
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("no taskId or taskTitle given");
  }

  const found = await ctx.runQuery(internal.model.tasks.findByTitle, { userId, title });
  if (!found) throw new Error(`no task matching "${title}"`);
  return found._id;
}

async function dispatch(
  ctx: ActionCtx,
  toolCtx: ToolContext,
  call: ToolCall,
): Promise<unknown> {
  const { userId, timezone } = toolCtx;
  const a = call.args;
  const instant = (value: unknown) =>
    typeof value === "string" ? toEpochMs(value, timezone) : undefined;

  switch (call.name) {
    case "memory.upsert_project":
      return await ctx.runMutation(internal.model.projects.upsert, {
        userId,
        name: a.name as string,
        status: a.status as string | undefined,
        objective: a.objective as string | undefined,
        priority: a.priority as number | undefined,
      });

    case "memory.get_project": {
      const found = await ctx.runQuery(internal.model.projects.getByName, {
        userId,
        name: a.name as string,
      });
      if (!found) return { found: false };
      return {
        found: true,
        name: found.project.name,
        status: found.project.status,
        objective: found.project.objective,
        tasks: found.tasks.map(summarizeTask(timezone)),
      };
    }

    case "task.create": {
      // The project name is ALSO a Linear label, per the owner's convention,
      // so it is kept in the Convex `projects` table on both backends: that
      // table is the project registry and the source of the label vocabulary,
      // whether or not Linear is the store for the tasks themselves.
      let projectId: Id<"projects"> | undefined;
      if (typeof a.projectName === "string" && a.projectName.length > 0) {
        const upserted = await ctx.runMutation(internal.model.projects.upsert, {
          userId,
          name: a.projectName,
        });
        projectId = upserted.projectId;
      }

      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        const apiKey = await linearApiKey(ctx, userId);
        const team = await resolveTeam(apiKey, a.teamKey as string | undefined);

        const wantedLabels = [
          ...(Array.isArray(a.labels) ? (a.labels as string[]) : []),
          ...(typeof a.projectName === "string" && a.projectName ? [a.projectName] : []),
        ];
        const { ids: labelIds, created: createdLabels } = await resolveLabelIds(
          apiKey,
          team.id,
          wantedLabels,
        );

        const dueAtMs = instant(a.dueAt);
        const entry: ChangesetEntry = {
          op: "create",
          teamId: team.id,
          title: a.title as string,
          description: a.detail as string | undefined,
          labelIds,
          priority: linearPriorityForInternal(a.priority as number | undefined),
          dueDate: dueAtMs === undefined ? undefined : linearDueDate(dueAtMs),
        };

        const labelNote = wantedLabels.length ? ` [${wantedLabels.join(", ")}]` : "";
        return {
          ...stage(toolCtx, entry, `new ${team.key} issue: "${a.title as string}"${labelNote}`),
          title: a.title,
          team: team.key,
          labels: wantedLabels,
          createdLabels,
        };
      }

      const created = await ctx.runMutation(internal.model.tasks.create, {
        userId,
        title: a.title as string,
        detail: a.detail as string | undefined,
        projectId,
        priority: a.priority as number | undefined,
        dueAt: instant(a.dueAt),
      });
      return { taskId: created.taskId, title: a.title };
    }

    case "task.list": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        const apiKey = await linearApiKey(ctx, userId);
        const limit = (a.limit as number | undefined) ?? 50;
        const { issues, truncated, matchedBy } = await findLinearIssues(apiKey, {
          status: a.status as TaskStatus | undefined,
          includeDone: a.includeDone === true,
          projectName: a.projectName as string | undefined,
          noProject: a.noProject === true,
          teamKey: a.teamKey as string | undefined,
        });
        const rows = issues.map(summarizeLinearIssue);
        return {
          backend: "linear",
          total: rows.length,
          // "at least" — more exist than were fetched. Never "all".
          truncated,
          matchedBy,
          tasks: rows.slice(0, limit),
          shown: Math.min(limit, rows.length),
        };
      }

      const tasks = await ctx.runQuery(internal.model.tasks.list, {
        userId,
        status: a.status as string | undefined,
        limit: Math.min((a.limit as number | undefined) ?? 15, 50),
      });
      return tasks.map(summarizeTask(timezone));
    }

    case "task.bulk_update": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend !== "linear") {
        throw new Error("bulk changes are only supported on the Linear task board");
      }
      const apiKey = await linearApiKey(ctx, userId);

      let issues: LinearIssueSummary[];
      let truncated = false;
      if (Array.isArray(a.taskIds) && a.taskIds.length > 0) {
        issues = [];
        for (const ref of a.taskIds as string[]) {
          const found = await getIssue(apiKey, ref);
          if (!found) throw new Error(`no Linear issue "${ref}"`);
          issues.push(found);
        }
      } else {
        const found = await findLinearIssues(apiKey, {
          status: a.fromStatus as TaskStatus | undefined,
          projectName: a.projectName as string | undefined,
          noProject: a.noProject === true,
          teamKey: a.teamKey as string | undefined,
        });
        issues = found.issues;
        truncated = found.truncated;
      }

      const toStatus = a.toStatus as TaskStatus;
      const statesByTeam = new Map<string, Awaited<ReturnType<typeof listWorkflowStates>>>();
      const entries: ChangesetEntry[] = [];
      const displays: string[] = [];
      const skipped: string[] = [];
      for (const issue of issues) {
        const teamKey = issue.team?.key ?? issue.identifier.split("-")[0] ?? "";
        let states = statesByTeam.get(teamKey);
        if (!states) {
          states = await listWorkflowStates(apiKey, teamKey);
          statesByTeam.set(teamKey, states);
        }
        const named =
          typeof a.stateName === "string" && a.stateName ? resolveStateByName(states, a.stateName) : null;
        const target = named ?? resolveStateForStatus(states, toStatus);
        if (!target) throw new Error(`${teamKey} has no workflow state for ${toStatus}`);
        if (target.id === issue.state.id) {
          skipped.push(issue.identifier);
          continue;
        }
        entries.push({ op: "update", issueId: issue.id, stateId: target.id });
        const where = issue.project?.name ? ` (${issue.project.name})` : "";
        displays.push(`${issue.identifier} ${issue.title}${where}: ${issue.state.name} → ${target.name}`);
      }

      if (entries.length === 0) {
        return { matched: issues.length, toChange: 0, skipped, awaitingApproval: false };
      }

      const opened = await openChangesetApproval(
        ctx,
        userId,
        timezone,
        entries,
        displays,
        `move ${entries.length} task${entries.length === 1 ? "" : "s"}`,
      );
      return {
        matched: issues.length,
        toChange: entries.length,
        skipped,
        truncated,
        awaitingApproval: true,
        approvalExpiresAt: opened.approvalExpiresAt,
        changes: displays,
      };
    }

    case "task.update": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        return await stageLinearUpdate(ctx, toolCtx, a, {
          title: a.title as string | undefined,
          description: a.detail as string | undefined,
          status: a.status as TaskStatus | undefined,
          priority: a.priority as number | undefined,
        });
      }

      return await ctx.runMutation(internal.model.tasks.update, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
        title: a.title as string | undefined,
        detail: a.detail as string | undefined,
        status: a.status as string | undefined,
        priority: a.priority as number | undefined,
        dueAt: instant(a.dueAt),
      });
    }

    case "task.complete": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        return await stageLinearUpdate(ctx, toolCtx, a, { status: "COMPLETED" });
      }

      return await ctx.runMutation(internal.model.tasks.complete, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
      });
    }

    case "task.block": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        return await stageLinearUpdate(ctx, toolCtx, a, {
          status: "BLOCKED",
          blockerReason: a.description as string,
        });
      }

      let waitingOn: Id<"people"> | undefined;
      if (typeof a.waitingOnPerson === "string" && a.waitingOnPerson.length > 0) {
        const person = await ctx.runMutation(internal.model.people.upsert, {
          userId,
          displayName: a.waitingOnPerson,
        });
        waitingOn = person.personId;
      }

      return await ctx.runMutation(internal.model.tasks.block, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
        description: a.description as string,
        waitingOn,
        expectedAt: instant(a.expectedAt),
      });
    }

    case "task.unblock": {
      const { backend } = await taskBackend(ctx, userId);
      if (backend === "linear") {
        return await stageLinearUpdate(ctx, toolCtx, a, {
          status: "RESUMED",
          clearBlocker: true,
        });
      }

      return await ctx.runMutation(internal.model.tasks.unblock, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
      });
    }

    case "reminder.create": {
      const scheduledAt = toEpochMs(a.scheduledAt as string, timezone);
      if (scheduledAt <= Date.now()) {
        throw new Error(
          `That time is in the past (${formatInstant(scheduledAt, timezone)}).`,
        );
      }
      const created = await ctx.runMutation(internal.model.reminders.create, {
        userId,
        message: a.message as string,
        scheduledAt,
      });
      return {
        reminderId: created.reminderId,
        scheduledFor: formatInstant(scheduledAt, timezone),
      };
    }

    case "reminder.list": {
      const pending = await ctx.runQuery(internal.model.reminders.listPending, {
        userId,
      });
      return pending.map((r) => ({
        reminderId: r._id,
        message: r.message,
        scheduledFor: formatInstant(r.scheduledAt, timezone),
      }));
    }

    case "reminder.cancel":
      return await ctx.runMutation(internal.model.reminders.cancel, {
        userId,
        reminderId: a.reminderId as string,
      });

    case "person.upsert":
      return await ctx.runMutation(internal.model.people.upsert, {
        userId,
        displayName: a.displayName as string,
        emails: a.emails as string[] | undefined,
        importance: a.importance as string | undefined,
        notes: a.notes as string | undefined,
      });

    case "account.connect_link": {
      const label = ((a.label as string | undefined) ?? "personal")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");
      const siteUrl = process.env.CONVEX_SITE_URL;
      if (!siteUrl) throw new Error("CONVEX_SITE_URL is not set on this deployment");

      const { nonce } = await ctx.runMutation(internal.model.oauthStates.issue, {
        userId,
        label: label || "personal",
      });
      return {
        label: label || "personal",
        url: `${siteUrl}/oauth/google/start?state=${nonce}`,
      };
    }

    case "email.list_recent":
    case "email.search": {
      const resolved = await resolveAccounts(ctx, userId, a.accountLabel);
      const scopeFailure = accountScopeFailure(resolved);
      if (scopeFailure) return scopeFailure;

      const limit = (a.limit as number | undefined) ?? 10;
      const criteria = {
        query: a.query as string | undefined,
        from: a.from as string | undefined,
        subject: a.subject as string | undefined,
        gmailLabel: a.gmailLabel as string | undefined,
      };
      const echo = {
        connected: true,
        ...criteria,
        accountLabel: a.accountLabel,
        searchedMailboxes: resolved.accountIds.map((id) => resolved.labels.get(id) ?? "?"),
      };

      // A window means "go to Gmail". Absent, the locally synced last 2 days
      // answer it with no network call — the common case, and the fast one.
      if (a.withinDays === undefined) {
        const rows = await ctx.runQuery(internal.model.emailMessages.search, {
          accountIds: resolved.accountIds,
          query: cachedNeedle(criteria),
          gmailLabel: criteria.gmailLabel,
          limit,
        });
        return {
          ...echo,
          withinDays: CACHED_WINDOW_DAYS,
          afterDays: 0,
          live: false,
          messages: rows.map((r) => summarizeEmail(r, false, resolved.labels)),
        };
      }

      const window = searchWindow(
        Date.now(),
        a.withinDays as number,
        (a.afterDays as number | undefined) ?? 0,
      );
      const found = await liveSearchAccounts(ctx, resolved, {
        ...criteria,
        afterMs: window.afterMs,
        beforeMs: window.beforeMs,
        limit,
      });
      return {
        ...echo,
        withinDays: window.withinDays,
        afterDays: window.afterDays,
        searchedFrom: window.afterMs,
        searchedTo: window.beforeMs,
        live: true,
        messages: found,
      };
    }

    case "calendar.list_events": {
      const win = resolveWindow(a as { window?: string; date?: string }, Date.now(), timezone);
      const found = await allCalendarEvents(ctx, userId, win, {
        query: a.query as string | undefined,
        limit: (a.limit as number | undefined) ?? 25,
      });
      return {
        window: (a.date as string | undefined) ?? (a.window as string | undefined) ?? "today",
        calendarsChecked: found.calendars,
        ...(found.failures.length ? { couldNotRead: found.failures } : {}),
        events: found.events.map((e) => summarizeEvent(e.event, timezone, found.calendars, e.calendarOf)),
      };
    }

    case "calendar.get_event": {
      // An event id is per-calendar, so try each connected calendar until one
      // knows it. Ids from list_events are what the model has.
      const accounts = await googleAccountsFor(ctx, userId, CALENDAR_READ_SCOPE);
      for (const account of accounts) {
        const accessToken = await ctx.runAction(internal.gmail.accessTokenForAccount, {
          accountId: account._id,
        });
        const event = await getEvent(accessToken, a.eventId as string);
        if (event) {
          return {
            found: true,
            ...summarizeEvent(event, timezone, accounts.map((x) => x.accountEmail), account.accountEmail),
            description: event.description,
          };
        }
      }
      return { found: false };
    }

    case "calendar.find_free_slots": {
      const win = resolveWindow(a as { window?: string; date?: string }, Date.now(), timezone);
      const found = await allCalendarEvents(ctx, userId, win, { limit: 100 });

      const busy = found.events
        .map((e) => ({
          startMs: whenToMs(e.event.start, timezone),
          endMs: whenToMs(e.event.end, timezone),
        }))
        .filter((i): i is { startMs: number; endMs: number } =>
          i.startMs !== null && i.endMs !== null);

      const slots = findFreeSlots({
        dates: win.dates,
        timeZone: timezone,
        busy,
        durationMs: (a.durationMinutes as number) * 60_000,
        nowMs: Date.now(),
        limit: (a.limit as number | undefined) ?? 5,
      });

      return {
        window: (a.date as string | undefined) ?? (a.window as string | undefined) ?? "today",
        durationMinutes: a.durationMinutes,
        calendarsChecked: found.calendars,
        ...(found.failures.length ? { couldNotRead: found.failures } : {}),
        slots: slots.map((sl) => ({
          startsAt: formatInstant(sl.startMs, timezone),
          endsAt: formatInstant(sl.endMs, timezone),
          startMs: sl.startMs,
        })),
      };
    }

    case "calendar.check_availability": {
      const startMs = toEpochMs(a.startsAt as string, timezone);
      const endMs =
        typeof a.endsAt === "string"
          ? toEpochMs(a.endsAt, timezone)
          : startMs + ((a.durationMinutes as number | undefined) ?? 60) * 60_000;
      if (endMs <= startMs) throw new Error("that time range ends before it starts");

      // Look an hour either side so near misses are visible.
      const found = await allCalendarEvents(
        ctx,
        userId,
        { startMs: startMs - NEARBY_MARGIN_MS, endMs: endMs + NEARBY_MARGIN_MS },
        { limit: 50 },
      );
      const answer = checkAvailability({ startMs, endMs, events: toCalendarItems(found.events, timezone) });

      const show = (e: CalendarItem) => ({
        title: e.title,
        startsAt: formatInstant(e.startMs, timezone),
        endsAt: formatInstant(e.endMs, timezone),
        calendarOf: e.calendarOf,
        ...(e.allDay ? { allDay: true } : {}),
      });
      return {
        askedAbout: `${formatInstant(startMs, timezone)} to ${formatInstant(endMs, timezone)}`,
        free: answer.free,
        conflicts: answer.conflicts.map(show),
        nearby: answer.nearby.map(show),
        calendarsChecked: found.calendars,
        ...(found.failures.length ? { couldNotRead: found.failures } : {}),
      };
    }

    case "calendar.create_event": {
      const { accessToken, account } = await googleAccountFor(ctx, userId, CALENDAR_WRITE_SCOPE);

      const startMs = toEpochMs(a.startsAt as string, timezone);
      const endMs =
        typeof a.endsAt === "string"
          ? toEpochMs(a.endsAt, timezone)
          : startMs + ((a.durationMinutes as number | undefined) ?? 60) * 60_000;
      if (endMs <= startMs) throw new Error("the event ends before it starts");

      const attendees = Array.isArray(a.attendees) ? (a.attendees as string[]) : [];

      const draft: CalendarEventEntry = {
        calendarId: "primary",
        summary: a.title as string,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        timeZone: timezone,
        description: a.description as string | undefined,
        location: a.location as string | undefined,
        attendees,
      };

      // THE PHASE 10 RULE. Consequentiality is about ATTENDEES, not about
      // writing. A solo block on your own calendar affects nobody, so
      // demanding a tap for it would make the tool annoying enough not to
      // use. An invitation reaches somebody else's inbox and their day, and
      // that is not the assistant's to decide.
      if (!affectsOthers(attendees, [account.accountEmail])) {
        const created = await createEvent(accessToken, {
          summary: draft.summary,
          description: draft.description,
          location: draft.location,
          startIso: draft.startIso,
          endIso: draft.endIso,
          timeZone: timezone,
        });
        return {
          created: true,
          title: created.summary ?? draft.summary,
          startsAt: formatInstant(startMs, timezone),
          endsAt: formatInstant(endMs, timezone),
          link: created.htmlLink,
        };
      }

      const hash = await calendarEventPayloadHash(draft);
      const eventDraftId = changesetIdFromHash(hash);

      await ctx.runMutation(internal.model.preferences.set, {
        userId,
        key: `calendar_event:${eventDraftId}`,
        value: { event: draft, createdAt: Date.now() },
      });

      const approval = await ctx.runMutation(internal.model.approvals.create, {
        userId,
        action: "calendar.apply_event",
        targetType: "calendar_events",
        targetId: eventDraftId,
        payloadHash: hash,
      });

      const user = await ctx.runQuery(internal.model.users.get, { userId });
      if (user) {
        const lines = [
          `<b>📅 Invitation — not sent yet</b>`,
          ``,
          `<b>What:</b>  ${escapeTelegramHtml(draft.summary)}`,
          `<b>When:</b>  ${escapeTelegramHtml(formatInstant(startMs, timezone))}`,
          `<b>Until:</b> ${escapeTelegramHtml(formatInstant(endMs, timezone))}`,
          ...(draft.location ? [`<b>Where:</b> ${escapeTelegramHtml(draft.location)}`] : []),
          ``,
          `<b>Invites will be emailed to:</b>`,
          ...attendees.map((x) => `  • ${escapeTelegramHtml(x)}`),
          ``,
          `From ${escapeTelegramHtml(account.accountEmail)}. ` +
            `Expires ${escapeTelegramHtml(formatInstant(approval.expiresAt, timezone))}.`,
        ];
        await sendCard(user.telegramId, alreadyHtml(lines.join("\n")), [
          [
            { text: "Send invite", data: `applyevent:${eventDraftId}` },
            { text: "Discard", data: `discardevent:${eventDraftId}` },
          ],
        ]);
      }

      return {
        created: false,
        awaitingApproval: true,
        eventDraftId,
        title: draft.summary,
        startsAt: formatInstant(startMs, timezone),
        attendees,
        expiresAt: formatInstant(approval.expiresAt, timezone),
      };
    }

    case "calendar.apply_event": {
      // Reached only once the gate matched this call to a CONSUMED approval.
      const { accessToken } = await googleAccountFor(ctx, userId, CALENDAR_WRITE_SCOPE);
      const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
      const stored = rows.find((p) => p.key === `calendar_event:${a.eventDraftId as string}`);
      if (!stored) throw new Error("that event is no longer pending — ask for it again");

      const event = (stored.value as { event: CalendarEventEntry }).event;
      const created = await createEvent(accessToken, {
        summary: event.summary,
        description: event.description,
        location: event.location,
        startIso: event.startIso,
        endIso: event.endIso,
        timeZone: event.timeZone,
        attendeeEmails: event.attendees,
      });

      return {
        created: true,
        title: created.summary ?? event.summary,
        startsAt: formatInstant(Date.parse(event.startIso), timezone),
        attendees: event.attendees ?? [],
        link: created.htmlLink,
      };
    }

    case "drive.search_files": {
      const { accessToken } = await googleAccountFor(ctx, userId, DRIVE_READ_SCOPE);
      const query = buildDriveQuery({
        name: a.name as string | undefined,
        text: a.text as string | undefined,
        mimeType: DRIVE_KINDS[(a.kind as string | undefined) ?? ""],
        ownedByMe: a.ownedByMe === true,
      });
      const files = await searchFiles(accessToken, {
        query,
        limit: (a.limit as number | undefined) ?? 10,
      });
      return {
        name: a.name,
        text: a.text,
        kind: a.kind,
        files: files.map((f) => summarizeFile(f, timezone)),
      };
    }

    case "drive.get_metadata": {
      const { accessToken } = await googleAccountFor(ctx, userId, DRIVE_READ_SCOPE);
      const file = await getFile(accessToken, a.fileId as string);
      if (!file) return { found: false };
      return { found: true, ...summarizeFile(file, timezone) };
    }

    case "drive.read_content": {
      const { accessToken } = await googleAccountFor(ctx, userId, DRIVE_READ_SCOPE);
      const file = await getFile(accessToken, a.fileId as string);
      if (!file) return { found: false };

      const plan = planRead(file.mimeType);
      if (plan.kind === "unreadable") {
        // Named, with a reason. "I couldn't read it" about an unidentified
        // file is not something the user can act on.
        return {
          found: true,
          readable: false,
          title: file.name,
          kind: fileKind(file.mimeType),
          reason: plan.reason,
        };
      }

      const content =
        plan.kind === "export"
          ? await exportFileText(accessToken, file.id, plan.exportMimeType, DRIVE_TEXT_CAP)
          : await downloadFileText(accessToken, file.id, DRIVE_TEXT_CAP);

      return {
        found: true,
        readable: true,
        title: file.name,
        kind: fileKind(file.mimeType),
        modifiedAt: file.modifiedTime
          ? formatInstant(Date.parse(file.modifiedTime), timezone)
          : undefined,
        link: file.webViewLink,
        content,
      };
    }

    case "email.archive":
    case "email.mark_read":
    case "email.mark_unread":
    case "email.label": {
      const message = await resolveEmailMessage(ctx, userId, a);
      if (!message) throw new Error("no email matching that");

      const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
        accountId: message.accountId,
      });
      // Ownership check, same as email.get_message: an id is a proposal, not
      // proof of access.
      if (!account || account.userId !== userId) throw new Error("no email matching that");

      let addLabelIds: string[] = [];
      let removeLabelIds: string[] = [];
      let createdLabel = false;
      let labelName: string | undefined;

      if (call.name === "email.archive") {
        // Archiving IS removing INBOX. Nothing is deleted and the message
        // stays in All Mail, which is why this needs no approval.
        removeLabelIds = ["INBOX"];
      } else if (call.name === "email.mark_read") {
        removeLabelIds = ["UNREAD"];
      } else if (call.name === "email.mark_unread") {
        addLabelIds = ["UNREAD"];
      } else {
        labelName = a.label as string;
        const resolved = await ctx.runAction(internal.gmail.resolveLabelId, {
          accountId: message.accountId,
          name: labelName,
        });
        createdLabel = resolved.created;
        if (a.remove === true) removeLabelIds = [resolved.labelId];
        else addLabelIds = [resolved.labelId];
      }

      const result = await ctx.runAction(internal.gmail.applyLabels, {
        emailMessageId: message._id,
        addLabelIds,
        removeLabelIds,
      });

      return {
        action: call.name,
        subject: message.subject ?? "(no subject)",
        from: message.fromName ?? message.fromAddress,
        accountLabel: account.label,
        label: labelName,
        removed: a.remove === true,
        createdLabel,
        inInbox: result.labelIds.includes("INBOX"),
        unread: result.labelIds.includes("UNREAD"),
      };
    }

    case "email.create_draft": {
      // Accept an id OR a fragment, same as email.get_message. The model
      // routinely has neither a Convex id nor a successful search behind it
      // — observed live proposing a GMAIL message id (18f3a38b556881c1),
      // which reached the mutation validator and surfaced a raw
      // ArgumentValidationError to the user. Resolve here instead.
      const message = await resolveEmailMessage(ctx, userId, a);
      if (!message) throw new Error("no email matching that");

      const emailMessageId = message._id;
      const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
        accountId: message.accountId,
      });
      // Same ownership check as email.get_message — an id is a proposal,
      // not proof of access.
      if (!account || account.userId !== userId) throw new Error("no email matching that");

      // The BODY writer gets a body-writing skill, never the chat-facing
      // draft_reply procedure. On 2026-08-23 it got draft_reply, whose §16
      // prescribes a "Draft reply / To: / Subject:" presentation block and
      // whose §17 adds "Please review the draft" — and the whole completion
      // was persisted as bodyText and emailed to a real recipient.
      const bodySkill = await ctx.runQuery(internal.model.skills.getEffective, {
        userId,
        name: "compose_email_body",
      });

      const draftBody = await runTask("DRAFT_REPLY", {
        // The skill governs voice, length and sign-off. The contract is
        // appended AFTER it so it reads last and a skill cannot redefine what
        // the output IS — same shape as COMPOSE_INVARIANTS in briefs.ts.
        system: `${bodySkill?.content ?? ""}\n${BODY_OUTPUT_CONTRACT}`,
        input:
          `Write a reply to the email below.\n\n` +
          `What it should say: ${a.talkingPoints as string}\n` +
          (a.tone ? `Tone: ${a.tone as string}\n` : ""),
        untrusted: [
          {
            label: "original_email",
            content:
              `From: ${message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}\n` +
              `Subject: ${message.subject ?? "(no subject)"}\n\n${message.bodyText ?? message.snippet ?? ""}`,
          },
        ],
        maxOutputTokens: 900,
      });

      // Refusing is a first-class outcome. Falling back to the raw completion
      // here is EXACTLY the bug — do not reintroduce it.
      const extracted = extractDraftBody(draftBody.text);
      if (!extracted.ok) {
        throw new Error(`I could not write that reply — ${extracted.reason}. Nothing was drafted.`);
      }
      const body = extracted.body;

      const to = [message.fromAddress];
      const subject = message.subject?.toLowerCase().startsWith("re:")
        ? message.subject
        : `Re: ${message.subject ?? "(no subject)"}`;
      const referencesHeader = [message.referencesHeader, message.rfcMessageId]
        .filter(Boolean)
        .join(" ");

      const created = await ctx.runMutation(internal.model.drafts.create, {
        emailMessageId,
        accountId: message.accountId,
        toAddresses: to,
        ccAddresses: [],
        subject,
        bodyText: body,
        inReplyTo: message.rfcMessageId,
        referencesHeader: referencesHeader || undefined,
      });

      const hash = await payloadHash({
        accountId: message.accountId,
        anchorId: emailMessageId,
        inReplyTo: message.rfcMessageId,
        to,
        cc: [],
        subject,
        body,
      });

      const approval = await ctx.runMutation(internal.model.approvals.create, {
        userId,
        action: "email.send_reply",
        targetType: "drafts",
        targetId: created.draftId,
        accountId: message.accountId,
        payloadHash: hash,
      });

      // The approval desk opens the moment the draft exists — no gap
      // between DRAFT CREATED and APPROVAL PENDING for the user to fall
      // into.
      const user = await ctx.runQuery(internal.model.users.get, { userId });
      if (user) {
        // The body goes ON the card, immediately above the button that sends
        // it. Composed here by code so that nothing between this line and the
        // user's eyes can summarise, truncate or rewrite it — the approval
        // binds a hash of exactly this text, so showing anything less means
        // asking for consent to something unread.
        const envelope = alreadyHtml(
          [
            `<b>📝 Draft reply</b>`,
            ``,
            `<b>To:</b>      ${escapeTelegramHtml(to.join(", "))}`,
            `<b>Subject:</b> ${escapeTelegramHtml(subject)}`,
            ``,
            `<blockquote>${escapeTelegramHtml(body)}</blockquote>`,
            ``,
            `Expires ${escapeTelegramHtml(formatInstant(approval.expiresAt, timezone))}.`,
          ].join("\n"),
        );

        // A card cannot be split — it carries the buttons — so an unusually
        // long body is sent as its own message(s) first and the card then
        // refers to it. capCard would otherwise silently hide the tail.
        if (envelope.length > CARD_BODY_LIMIT) {
          await sendMessage(
            user.telegramId,
            `**Draft reply**\nTo: ${to.join(", ")}\nSubject: ${subject}\n\n${body}`,
          );
        }

        await sendCard(
          user.telegramId,
          envelope.length > CARD_BODY_LIMIT
            ? alreadyHtml(
                `Send the reply above to <b>${escapeTelegramHtml(to.join(", "))}</b>?\n` +
                  `Expires ${escapeTelegramHtml(formatInstant(approval.expiresAt, timezone))}.`,
              )
            : envelope,
          // sendCard takes ROWS of buttons; one row of two here.
          [
            [
              { text: "Send", data: `senddraft:${created.draftId}` },
              { text: "Discard", data: `discarddraft:${created.draftId}` },
            ],
          ],
        );
      }

      return {
        draftId: created.draftId,
        to,
        subject,
        body,
        approvalExpiresAt: formatInstant(approval.expiresAt, timezone),
      };
    }

    case "linear.list_issues": {
      const apiKey = await linearApiKey(ctx, userId);
      return await listIssues(apiKey, {
        teamKey: a.teamKey as string | undefined,
        stateName: a.stateName as string | undefined,
        limit: (a.limit as number | undefined) ?? 10,
      });
    }

    case "linear.get_issue": {
      const apiKey = await linearApiKey(ctx, userId);
      const issue = await getIssue(apiKey, a.issueRef as string);
      if (!issue) return { found: false };
      return { found: true, ...issue };
    }

    case "linear.propose_changeset": {
      const apiKey = await linearApiKey(ctx, userId);
      const changes = await toLinearChanges(apiKey, a.changes as Array<Record<string, unknown>>);

      const displays = changes.map((c) => {
        const parts: string[] = [];
        if (c.stateName) parts.push(`state → ${c.stateName}`);
        if (c.title) parts.push(`title → "${c.title}"`);
        if (c.priority !== undefined) {
          parts.push(`priority → ${LINEAR_PRIORITY_NAMES[c.priority] ?? c.priority}`);
        }
        if (c.description) parts.push("description updated");
        return `${c.issueId} — ${parts.join(", ") || "no change"}`;
      });

      const opened = await openChangesetApproval(
        ctx,
        userId,
        timezone,
        changes,
        displays,
        String(a.summary),
      );

      return {
        changesetId: opened.changesetId,
        summary: a.summary,
        changes,
        approvalExpiresAt: opened.approvalExpiresAt,
      };
    }

    case "linear.apply_changeset": {
      // Reached only once Phase 6's consequential gate has already matched
      // this exact call to a CONSUMED approval — dispatch's job here is
      // only to execute, never to re-decide whether it's allowed to.
      const changes = await resolveChangeset(ctx, userId, a);
      const apiKey = await linearApiKey(ctx, userId);

      // One batch can hold both new issues and edits to existing ones — a
      // turn like "add these two and close ENG-12" is one approval. They are
      // different Linear mutations, so they are split here rather than in the
      // approval, which cares only that the payload hash still matches.
      const creates: LinearIssueCreate[] = [];
      const updates: LinearIssueChange[] = [];
      for (const change of changes) {
        if (change.op === "create" && change.teamId) {
          creates.push({
            teamId: change.teamId,
            title: change.title ?? "(untitled)",
            description: change.description,
            stateId: change.stateId,
            labelIds: change.labelIds,
            priority: change.priority,
            dueDate: change.dueDate,
          });
        } else if (change.issueId) {
          updates.push({
            issueId: change.issueId,
            title: change.title,
            description: change.description,
            stateId: change.stateId,
            priority: change.priority,
          });
        }
      }

      const created = await createIssues(apiKey, creates);
      const results: Awaited<ReturnType<typeof applyChangeset>> = [];
      // Linear accepts ~50 aliased mutations comfortably; 25 keeps one
      // request well inside its complexity budget for a big bulk change.
      for (let i = 0; i < updates.length; i += 25) {
        results.push(...(await applyChangeset(apiKey, updates.slice(i, i + 25))));
      }

      // Read the board back. "success: true" from a mutation is Linear's
      // word; the state on the board afterwards is the fact the user cares
      // about, and the reply must be built from that, not from the request.
      const verification = await verifyStates(apiKey, updates);
      return { created, results, verification };
    }

    case "note.save": {
      const saved = await createNote({
        title: a.title as string,
        markdown: a.content as string,
        category: a.category as string | undefined,
      });
      return {
        pageId: saved.pageId,
        url: saved.url,
        title: saved.title,
        category: saved.category,
      };
    }

    case "note.categories": {
      try {
        return { reachable: true, categories: await listCategories() };
      } catch (error) {
        if (error instanceof NotionUnavailable) {
          return { reachable: false, reason: error.userFacing };
        }
        throw error;
      }
    }

    case "note.search": {
      // A Notion failure must never render as "you have no notes about that".
      // With no local copy, that sentence would be a false statement about
      // the user's own data — see NotionUnavailable.userFacing.
      try {
        const notes = await searchNotes(
          (a.query as string) ?? "",
          (a.limit as number | undefined) ?? 10,
          a.category as string | undefined,
        );
        return { reachable: true, notes };
      } catch (error) {
        if (error instanceof NotionUnavailable) {
          return { reachable: false, reason: error.userFacing };
        }
        throw error;
      }
    }

    case "note.get": {
      try {
        // Resolve a title to an id HERE, in code — the same id-or-fragment
        // shape tasks, emails and meetings already use. The model supplies
        // words; it never has to have seen an id.
        let pageId = a.pageId as string | undefined;
        if (!pageId) {
          const hit = await findNote(
            a.titleFragment as string,
            a.category as string | undefined,
          );
          if (!hit) {
            return { reachable: true, notFound: true, query: a.titleFragment };
          }
          pageId = hit.pageId;
        }

        const note = await readNote(pageId);
        return { reachable: true, ...note };
      } catch (error) {
        if (error instanceof NotionUnavailable) {
          return { reachable: false, reason: error.userFacing };
        }
        throw error;
      }
    }

    case "link.read": {
      const proposed = (a.url as string).trim();

      // THE URL MUST HAVE COME FROM THE USER.
      //
      // link.read is the only tool that sends a request somewhere the user's
      // own configuration did not decide, so it is the only tool with an
      // exfiltration shape: a URL found inside an email or a document could
      // carry data out in its path. The allowlist already bounds WHERE, and
      // this bounds WHO CHOSE. Untrusted content proposes nothing.
      const recent = await ctx.runQuery(internal.model.messages.recentForUser, {
        userId,
        limit: 12,
      });
      const saidByUser = recent
        .filter((m) => m.direction === "in")
        .flatMap((m) => extractUrls(m.text ?? ""));

      const matched = saidByUser.find(
        (u) => u === proposed || detectPlatform(u)?.canonicalUrl === proposed,
      );
      if (!matched) {
        throw new Error(
          "I only open links you sent me yourself — I can't open one that came from an email, a document, or a web page.",
        );
      }

      const link = detectPlatform(matched);
      if (!link) {
        throw new Error("that isn't a link from a platform I can read");
      }

      // Reads the caption, every slide (OCR) and a short video, and files the
      // post so saved.search finds it later. A link saved before comes back
      // from the database without being fetched again.
      const saved = await ingestLink(ctx, userId, matched);
      const slides = saved.slides ?? [];
      return {
        itemId: saved.itemId,
        fresh: saved.fresh,
        platform: saved.platform,
        url: saved.url,
        authorName: saved.author,
        title: saved.title,
        summary: saved.summary,
        caption: saved.caption,
        imageText:
          slides.length > 0
            ? slides.map((sl) => (slides.length > 1 ? `--- Slide ${sl.index} ---\n${sl.text}` : sl.text)).join("\n\n")
            : undefined,
        imagesRead: slides.length,
        videoTranscript: saved.videoTranscript,
        entities: saved.entities,
        status: saved.status,
        slidesUnavailable: saved.status === "partial",
        note: saved.note,
        lists: Object.keys(parseNotionLists(process.env.NOTION_LISTS)),
      };
    }

    case "saved.search": {
      const hits = await searchSaved(ctx, userId, a.query as string, {
        limit: (a.limit as number | undefined) ?? 5,
        ...(a.type ? { type: a.type as string } : {}),
      });
      return { query: a.query, count: hits.length, items: hits };
    }

    case "saved.get": {
      const item = await ctx.runQuery(internal.model.saved.get, { itemId: a.itemId as Id<"savedItems"> });
      if (!item || item.userId !== userId || item.hidden) throw new Error("no saved post with that id");
      const entities = await ctx.runQuery(internal.model.saved.entitiesFor, { itemId: item._id });
      return toView(item, entities);
    }

    case "saved.recent": {
      const items = await ctx.runQuery(internal.model.saved.recent, {
        userId,
        limit: (a.limit as number | undefined) ?? 10,
      });
      return {
        items: items.map((i) => ({
          itemId: i._id,
          title: i.title,
          author: i.author,
          platform: i.platform,
          url: i.url,
          status: i.status,
          savedAt: formatInstant(i.savedAt, timezone),
        })),
      };
    }

    case "saved.forget": {
      const result = await ctx.runMutation(internal.model.saved.hide, {
        userId,
        itemId: a.itemId as Id<"savedItems">,
      });
      if (!result.hidden) throw new Error("no saved post with that id");
      return result;
    }

    case "list.query": {
      const lists = parseNotionLists(process.env.NOTION_LISTS);
      const key = resolveListName(lists, a.list as string);
      if (!key) {
        // No Notion list for it: fall back to what saved posts mentioned.
        const type = (a.list as string).toLowerCase().replace(/s$/, "");
        const rows = await ctx.runQuery(internal.model.saved.entitiesByType, { userId, type, limit: 50 });
        return {
          list: a.list,
          source: "saved posts",
          configuredLists: Object.keys(lists),
          items: rows.map((e) => ({ name: e.name, detail: e.detail, status: e.status })),
        };
      }
      const rows = await queryList(lists[key]!);
      const shown = a.includeFinished === true ? rows : rows.filter((r) => !r.finished);
      return {
        list: key,
        source: "notion",
        total: rows.length,
        unfinished: rows.filter((r) => !r.finished).length,
        items: shown.map((r) => ({ name: r.name, detail: r.detail, status: r.status, source: r.source })),
      };
    }

    case "list.mark_done": {
      const lists = parseNotionLists(process.env.NOTION_LISTS);
      const key = resolveListName(lists, a.list as string);
      if (!key) throw new Error(`there's no Notion list called "${a.list as string}" — set it up in NOTION_LISTS`);
      const wanted = captureKey(a.name as string);
      const rows = await queryList(lists[key]!);
      const row =
        rows.find((r) => captureKey(r.name) === wanted) ??
        rows.find((r) => captureKey(r.name).includes(wanted) || wanted.includes(captureKey(r.name)));
      if (!row) throw new Error(`"${a.name as string}" isn't on your ${key} list`);
      const done = await markListRowFinished(lists[key]!, row.pageId);
      return { list: key, name: row.name, status: done.status };
    }

    case "capture.propose": {
      const raw = (a.items as CaptureItem[]) ?? [];
      const { items, duplicates, overflow } = normalizeBatch(raw);
      if (items.length === 0) throw new Error("nothing to add — no usable items in that list");

      const destination = a.destination as CaptureDestination;
      let category = a.category as string | undefined;
      if (destination === "list") {
        const lists = parseNotionLists(process.env.NOTION_LISTS);
        const key = category ? resolveListName(lists, category) : null;
        if (!key) {
          const names = Object.keys(lists);
          throw new Error(
            names.length > 0
              ? `no list called "${category ?? ""}" — your lists are: ${names.join(", ")}`
              : "no Notion lists are set up yet (NOTION_LISTS) — save these as notes instead",
          );
        }
        category = key;
      }

      const batch: CaptureBatchEntry = {
        destination,
        category,
        title: a.title as string,
        items,
        sourceUrl: a.sourceUrl as string | undefined,
      };

      const hash = await captureBatchPayloadHash(batch);
      const batchId = changesetIdFromHash(hash);

      await ctx.runMutation(internal.model.preferences.set, {
        userId,
        key: `capture_batch:${batchId}`,
        value: { batch, createdAt: Date.now() },
      });

      const approval = await ctx.runMutation(internal.model.approvals.create, {
        userId,
        action: "capture.apply",
        targetType: "capture_batches",
        targetId: batchId,
        payloadHash: hash,
      });

      const user = await ctx.runQuery(internal.model.users.get, { userId });
      if (user) {
        // The full list, numbered. The user is approving THESE items, so
        // showing a count and hiding the contents would make the tap
        // meaningless — a misread carousel has to be visible before it lands.
        const lines = [
          `<b>📥 ${escapeTelegramHtml(batch.title)}</b>`,
          escapeTelegramHtml(describeBatch(items.length, destination, category)),
          ``,
          ...items.map(
            (item, n) =>
              `${n + 1}. <b>${escapeTelegramHtml(item.title)}</b>` +
              (item.detail ? ` — ${escapeTelegramHtml(item.detail)}` : ""),
          ),
        ];
        if (duplicates.length > 0) {
          lines.push("", `Skipped ${duplicates.length} duplicate${duplicates.length === 1 ? "" : "s"}.`);
        }
        if (overflow > 0) {
          lines.push("", `⚠️ ${overflow} more were found and left out — the cap is 30.`);
        }
        lines.push(
          ``,
          `Expires ${escapeTelegramHtml(formatInstant(approval.expiresAt, timezone))}.`,
        );

        await sendCard(user.telegramId, alreadyHtml(lines.join("\n")), [
          [
            { text: `Add all ${items.length}`, data: `applybatch:${batchId}` },
            { text: "Cancel", data: `discardbatch:${batchId}` },
          ],
        ]);
      }

      return {
        batchId,
        awaitingApproval: true,
        title: batch.title,
        destination,
        category,
        count: items.length,
        items,
        duplicates: duplicates.length,
        overflow,
        expiresAt: formatInstant(approval.expiresAt, timezone),
      };
    }

    case "capture.apply": {
      // Reached only once the gate matched this call to a CONSUMED approval.
      const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
      const stored = rows.find((p) => p.key === `capture_batch:${a.batchId as string}`);
      if (!stored) throw new Error("that list is no longer pending — ask for it again");

      const batch = (stored.value as { batch: CaptureBatchEntry }).batch;

      if (batch.destination === "notes") {
        // ONE note holding the whole list, not one note per item: a watchlist
        // is a list, and ten near-identical pages would be ten near-identical
        // search hits forever after.
        const saved = await createNote({
          title: batch.title,
          markdown: renderBatchMarkdown(batch.items, {
            url: batch.sourceUrl,
          }),
          category: batch.category,
        });
        return {
          applied: true,
          destination: "notes",
          count: batch.items.length,
          title: saved.title,
          category: saved.category,
          url: saved.url,
        };
      }

      if (batch.destination === "list") {
        const lists = parseNotionLists(process.env.NOTION_LISTS);
        const databaseId = batch.category ? lists[batch.category] : undefined;
        if (!databaseId) throw new Error(`the "${batch.category ?? ""}" list is no longer set up`);
        const results = await addListRows(
          databaseId,
          batch.items.map((item) => ({
            name: item.title,
            ...(item.detail ? { detail: item.detail } : {}),
            ...(batch.sourceUrl ? { sourceUrl: batch.sourceUrl } : {}),
          })),
        );
        const added = results.filter((r) => r.pageId);
        const failed = results.filter((r) => !r.pageId);

        // Remember which of the post's films/tools are now on a list, so
        // "which movie should I watch" knows and a re-capture skips them.
        if (batch.sourceUrl && added.length > 0) {
          const link = detectPlatform(batch.sourceUrl);
          const entities = await ctx.runQuery(internal.model.saved.entitiesForUrl, {
            userId,
            url: link?.canonicalUrl ?? batch.sourceUrl,
          });
          const matches = added
            .map((r) => ({ r, e: entities.find((e) => captureKey(e.name) === captureKey(r.name)) }))
            .filter((m): m is { r: (typeof added)[number]; e: (typeof entities)[number] } => m.e !== undefined);
          if (matches.length > 0) {
            await ctx.runMutation(internal.model.saved.markEntities, {
              ids: matches.map((m) => m.e._id),
              status: "in_list",
              list: batch.category,
              notionPageIds: matches.map((m) => m.r.pageId ?? ""),
            });
          }
        }
        return {
          applied: true,
          destination: "list",
          category: batch.category,
          count: added.length,
          attempted: batch.items.length,
          failed: failed.map((f) => `${f.name}: ${f.error ?? "unknown error"}`),
        };
      }

      // Tasks. On the Linear backend these STAGE, and the caller flushes them
      // into a second card — which is correct: this approval covered "capture
      // these items", and writing to a shared tracker is its own decision.
      const created: string[] = [];
      for (const item of batch.items) {
        const outcome = await executeToolCall(ctx, toolCtx, {
          name: "task.create",
          args: {
            title: item.title,
            ...(item.detail ? { detail: item.detail } : {}),
            ...(batch.category ? { labels: [batch.category] } : {}),
          },
        });
        if (outcome.ok) created.push(item.title);
      }

      return {
        applied: true,
        destination: "tasks",
        count: created.length,
        attempted: batch.items.length,
        staged: (toolCtx.staged?.length ?? 0) > 0,
      };
    }

    case "meeting.ingest": {
      // The heavy lifting is an action of its own: two model passes plus the
      // deterministic apply. The router stays a dispatcher.
      return await ctx.runAction(internal.meetings.ingest, {
        userId,
        transcript: a.transcript as string,
        title: a.title as string | undefined,
        occurredAt: a.occurredAt as string | undefined,
      });
    }

    case "meeting.list": {
      const rows = await ctx.runQuery(internal.model.meetings.list, {
        userId,
        limit: (a.limit as number | undefined) ?? 10,
      });
      return {
        meetings: rows.map((m) => ({
          title: m.title,
          occurredAt: formatInstant(m.occurredAt, timezone),
          taskCount: m.createdTaskIds.length,
        })),
      };
    }

    case "meeting.get": {
      const row = a.meetingId
        ? await ctx.runQuery(internal.model.meetings.getById, {
            userId,
            meetingId: a.meetingId as Id<"meetings">,
          })
        : await ctx.runQuery(internal.model.meetings.findByFragment, {
            userId,
            fragment: a.titleFragment as string,
          });
      if (!row) throw new Error("no meeting matching that");

      const extraction = row.extraction as {
        personalTldr?: string;
        decisions?: string[];
        commitments?: { who: string; what: string; owner: string }[];
      };
      return {
        title: row.title,
        occurredAt: formatInstant(row.occurredAt, timezone),
        personalTldr: extraction.personalTldr ?? "",
        decisions: extraction.decisions ?? [],
        commitments: extraction.commitments ?? [],
      };
    }

    case "email.add_rule": {
      const result = await ctx.runMutation(internal.model.emailRules.add, {
        userId,
        senderPattern: a.senderPattern as string | undefined,
        subjectPattern: a.subjectPattern as string | undefined,
        category: a.category as string | undefined,
        accountLabel: a.accountLabel as string | undefined,
        action: a.action as string,
        reason: a.reason as string | undefined,
      });
      return {
        created: result.created,
        description: describeRule({
          senderPattern: a.senderPattern
            ? normalizePattern(a.senderPattern as string)
            : undefined,
          subjectPattern: a.subjectPattern as string | undefined,
          category: a.category as string | undefined,
          accountLabel: a.accountLabel as string | undefined,
          action: a.action as RuleAction,
        }),
      };
    }

    case "email.list_rules": {
      const rows = await ctx.runQuery(internal.model.emailRules.list, { userId });
      return {
        rules: rows.map((r) => ({
          description: describeRule({
            senderPattern: r.senderPattern,
            subjectPattern: r.subjectPattern,
            category: r.category,
            accountLabel: r.accountLabel,
            action: r.action as RuleAction,
          }),
          reason: r.reason,
        })),
      };
    }

    case "email.remove_rule": {
      const result = await ctx.runMutation(internal.model.emailRules.removeByFragment, {
        userId,
        fragment: a.fragment as string,
      });
      return { removed: result.removed };
    }

    case "email.discard_draft": {
      const draftId = a.draftId as Id<"drafts">;
      await ctx.runMutation(internal.model.approvals.rejectForTarget, {
        action: "email.send_reply",
        targetType: "drafts",
        targetId: draftId,
      });
      const result = await ctx.runMutation(internal.model.drafts.discard, { draftId });
      return { discarded: result.discarded };
    }

    case "email.send_reply": {
      // Reached only once executeToolCall's gate has confirmed a CONSUMED
      // approval exists for this exact draft.
      const draftId = a.draftId as Id<"drafts">;
      const approval = await ctx.runQuery(internal.model.approvals.findLive, {
        action: "email.send_reply",
        targetType: "drafts",
        targetId: draftId,
      });
      if (!approval || approval.status !== "CONSUMED") {
        // Defensive only — the gate above already guarantees this.
        throw new Error("no consumed approval for this draft");
      }
      await ctx.runAction(internal.gmail.sendReply, { draftId, approvalId: approval._id });
      return { sent: true, draftId };
    }

    case "email.summarize_thread": {
      const message = await ctx.runQuery(internal.model.emailMessages.getById, {
        emailMessageId: a.emailMessageId as Id<"emailMessages">,
      });
      if (!message) return { found: false };

      const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
        accountId: message.accountId,
      });
      if (!account || account.userId !== userId) return { found: false };

      const body = message.bodyText ?? message.snippet ?? "";
      const summary = await runTask("SUMMARIZE_THREAD", {
        system:
          "Summarize this email in two or three sentences a busy person can act on. " +
          "Plain text, no markdown, no preamble.",
        input: `Subject: ${message.subject ?? "(no subject)"}\nFrom: ${
          message.fromName ?? message.fromAddress
        }`,
        untrusted: [{ label: "email_body", content: body }],
        maxOutputTokens: 300,
      });

      return { found: true, summary: summary.text.trim() };
    }

    case "email.get_message": {
      const resolved = await resolveAccounts(ctx, userId, a.accountLabel);
      let message;
      if (a.emailMessageId) {
        message = await ctx.runQuery(internal.model.emailMessages.getById, {
          emailMessageId: a.emailMessageId as Id<"emailMessages">,
        });
      } else {
        // No id was given — resolve "that FairMoney email" by fragment,
        // scoped to the same accounts a search/list_recent would use.
        const scopeFailure = accountScopeFailure(resolved);
        if (scopeFailure) return { found: false, ...scopeFailure };
        message = await ctx.runQuery(internal.model.emailMessages.findByFragment, {
          accountIds: resolved.accountIds,
          fragment: a.senderOrSubject as string,
        });
      }
      if (!message) return { found: false };

      const account = await ctx.runQuery(internal.model.connectedAccounts.get, {
        accountId: message.accountId,
      });
      // Ownership check: an id is a proposal, not proof of access. A message
      // belonging to a different user's account must not be readable just
      // because its id was guessed or reused across a conversation.
      if (!account || account.userId !== userId) return { found: false };

      // `mode` rides back out on the result so the orchestrator can decide
      // whether the body must be preserved verbatim (full) or handed to a
      // model to summarize (summary) — see converse() in assistant.ts.
      return {
        found: true,
        mode: (a.mode as string | undefined) ?? "summary",
        ...summarizeEmail(message, true, resolved.labels),
      };
    }

    case "instruction.add": {
      const created = await ctx.runMutation(internal.model.instructions.add, {
        userId,
        text: a.text as string,
      });
      // Echo the text back — task.create and reminder.create do the same,
      // since the mutation only returns the id and outcomes.ts renders a
      // confirmation that needs the content, not just proof it was stored.
      return { instructionId: created.instructionId, text: a.text };
    }

    case "instruction.list": {
      const rows = await ctx.runQuery(internal.model.instructions.list, { userId });
      return rows.map((r) => ({ instructionId: r._id, text: r.text }));
    }

    case "instruction.remove": {
      let instructionId = a.instructionId as string | undefined;
      if (!instructionId && typeof a.textFragment === "string") {
        const found = await ctx.runQuery(internal.model.instructions.findByFragment, {
          userId,
          fragment: a.textFragment,
        });
        if (!found) return { removed: false };
        instructionId = found._id;
      }
      if (!instructionId) throw new Error("no instructionId or textFragment given");

      return await ctx.runMutation(internal.model.instructions.remove, {
        userId,
        instructionId: instructionId as Id<"customInstructions">,
      });
    }

    case "skill.update": {
      const result = await ctx.runMutation(internal.model.skills.upsert, {
        userId,
        name: a.name as string,
        title: a.title as string,
        content: a.content as string,
      });
      // Echo the name back — same reason task.create/instruction.add do:
      // the mutation only returns an id, and outcomes.ts needs the content
      // to confirm, not just proof it was stored.
      return { ...result, name: a.name };
    }

    case "skill.list":
      return await ctx.runQuery(internal.model.skills.list, { userId });

    case "skill.get": {
      const found = await ctx.runQuery(internal.model.skills.getEffective, {
        userId,
        name: a.name as string,
      });
      if (!found) return { found: false, name: a.name };
      return { found: true, name: a.name, ...found };
    }

    case "brief.configure": {
      const updated = await ctx.runMutation(internal.model.briefConfig.configure, {
        userId,
        timezone,
        enabled: a.enabled as boolean | undefined,
        timeOfDay: a.timeOfDay as string | undefined,
        notes: a.notes as string | undefined,
      });
      return {
        enabled: updated.enabled,
        timeOfDay: updated.timeOfDay,
        notes: updated.notes,
        nextAt:
          updated.nextAt === undefined ? undefined : formatInstant(updated.nextAt, timezone),
      };
    }

    case "brief.preview": {
      const text = await ctx.runAction(internal.briefs.compose, { userId });
      return { text };
    }

    case "context.set": {
      const category = normalizeCategory((a.category as string | undefined) ?? "other");
      // The mutation echoes `text` back — outcomes.ts confirms WHAT was
      // saved, not merely that something was. Omitting this echo produced an
      // empty confirmation twice before (instruction.add, skill.update).
      return await ctx.runMutation(internal.model.userContext.add, {
        userId,
        category,
        text: a.text as string,
      });
    }

    case "context.list": {
      const rows = await ctx.runQuery(internal.model.userContext.list, { userId });
      return rows.map((r) => ({ contextId: r._id, category: r.category, text: r.text }));
    }

    case "context.remove": {
      let contextId = a.contextId as string | undefined;
      if (!contextId && typeof a.textFragment === "string") {
        const found = await ctx.runQuery(internal.model.userContext.findByFragment, {
          userId,
          fragment: a.textFragment,
        });
        if (!found) return { removed: false };
        contextId = found._id;
      }
      if (!contextId) throw new Error("no contextId or textFragment given");

      return await ctx.runMutation(internal.model.userContext.remove, {
        userId,
        contextId: contextId as Id<"userContext">,
      });
    }
  }
}

/** What the background sync keeps locally — see SYNC_WINDOW in gmail.ts. */
const CACHED_WINDOW_DAYS = 2;

/**
 * The cached path has one free-text field, not three. Fold the structured
 * criteria into a single needle rather than dropping them: a `from` the local
 * matcher ignored would silently widen the search, which is the failure this
 * whole change exists to remove.
 */
function cachedNeedle(criteria: { query?: string; from?: string; subject?: string }): string | undefined {
  return criteria.from ?? criteria.subject ?? criteria.query;
}

/**
 * Two different empty results that must not render the same way.
 *
 * `unknownLabel` means the user has mailboxes but none by that name — saying
 * "no mailbox connected" there is a false statement about their own data.
 */
function accountScopeFailure(resolved: ResolvedAccounts) {
  if (resolved.unknownLabel !== undefined) {
    return {
      connected: true,
      unknownLabel: resolved.unknownLabel,
      available: resolved.available,
    };
  }
  if (resolved.accountIds.length === 0) return { connected: false };
  return null;
}

/**
 * Runs a live Gmail query against every given account and merges the results.
 *
 * Deliberately sequential, not `Promise.all` — this is already the slow path
 * (a live Gmail call per message, not a cached read), and running N accounts
 * concurrently multiplies the load on a single inbound tool call rather than
 * spreading it the way the background sync's round-robin does.
 */
async function liveSearchAccounts(
  ctx: ActionCtx,
  resolved: ResolvedAccounts,
  filters: {
    query?: string;
    from?: string;
    subject?: string;
    gmailLabel?: string;
    afterMs: number;
    beforeMs: number;
    limit: number;
  },
) {
  // Built HERE, from typed fields, and never from a string the model wrote.
  const query = buildGmailQuery(filters);

  const allIds: string[] = [];
  for (const accountId of resolved.accountIds) {
    const found = await ctx.runAction(internal.gmail.deepSearch, {
      accountId,
      query,
      maxResults: filters.limit,
    });
    allIds.push(...found.emailMessageIds);
  }

  const messages = [];
  for (const emailMessageId of allIds) {
    const message = await ctx.runQuery(internal.model.emailMessages.getById, {
      emailMessageId: emailMessageId as Id<"emailMessages">,
    });
    if (message) messages.push(summarizeEmail(message, false, resolved.labels));
  }

  // Merging N accounts leaves them concatenated, not interleaved — a
  // two-mailbox search used to list all of one then all of the other, in an
  // order that read as random. And `limit` was ignored entirely.
  messages.sort((x, y) => y.receivedAtMs - x.receivedAtMs);
  return messages.slice(0, filters.limit);
}

/**
 * What a mailbox-scoped read resolved to.
 *
 * Richer than the bare id list it replaces, because the two failure modes are
 * NOT the same fact and used to be rendered identically. "No account matched
 * the label 'work'" came back as an empty array, which the handlers turned
 * into `{connected:false}` and the renderer printed as "No mailbox
 * connected." — a false statement about mailboxes that were connected and
 * syncing, and one the user has no way to check.
 */
interface ResolvedAccounts {
  accountIds: Id<"connectedAccounts">[];
  /** accountId -> label, so a result row can name the mailbox it came from. */
  labels: Map<string, string>;
  /** Set only when a label WAS given and matched nothing. */
  unknownLabel?: string;
  /** Every active label, so the error can say what does exist. */
  available: string[];
}

async function resolveAccounts(
  ctx: ActionCtx,
  userId: Id<"users">,
  label: unknown,
): Promise<ResolvedAccounts> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
    userId,
  });
  // Gmail only. `listForUser` returns every provider, so a connected Linear
  // row would otherwise be offered as a mailbox to search — and named as one
  // in "you have: personal, primary, linear".
  const active = accounts.filter((acc) => acc.status === "ACTIVE" && acc.provider === "gmail");
  const labels = new Map(active.map((a) => [a._id as string, a.label]));
  const available = [...new Set(active.map((a) => a.label))];

  if (typeof label !== "string" || label.length === 0) {
    return { accountIds: active.map((a) => a._id), labels, available };
  }

  const matched = active.filter((a) => a.label.toLowerCase() === label.toLowerCase());
  if (matched.length === 0 && active.length > 0) {
    return { accountIds: [], labels, available, unknownLabel: label };
  }
  return { accountIds: matched.map((a) => a._id), labels, available };
}

/** The id-only view, for callers that only need a scope to search within. */
async function resolveAccountIds(
  ctx: ActionCtx,
  userId: Id<"users">,
  label: unknown,
): Promise<Id<"connectedAccounts">[]> {
  return (await resolveAccounts(ctx, userId, label)).accountIds;
}

interface EmailLike {
  _id: string;
  accountId: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  labelIds: string[];
  receivedAt: number;
  importance?: string;
}

function summarizeEmail(message: EmailLike, full = false, labels?: Map<string, string>) {
  return {
    emailMessageId: message._id,
    from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
    subject: message.subject ?? "(no subject)",
    receivedAt: new Date(message.receivedAt).toISOString(),
    receivedAtMs: message.receivedAt,
    spam: message.labelIds.includes("SPAM"),
    // Which inbox this came from. Without it a cross-mailbox search returns
    // rows the model cannot attribute, so "was that in my work or personal
    // mail?" was unanswerable even though the answer was in the row.
    accountLabel: labels?.get(message.accountId as string),
    importance: message.importance,
    // Full detail gets the body (already capped at 32 KB by the normalizer);
    // a list gets only the snippet, so a ten-message list does not balloon.
    ...(full
      ? { body: message.bodyText ?? message.snippet ?? "" }
      : { snippet: message.snippet ?? "" }),
  };
}

function summarizeTask(timezone: string) {
  return (task: {
    _id: string;
    title: string;
    status: string;
    priority: number;
    dueAt?: number;
  }) => ({
    taskId: task._id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt === undefined ? undefined : formatInstant(task.dueAt, timezone),
  });
}

// The reply-body prompt now lives in DEFAULT_SKILLS.compose_email_body
// (convex/lib/skills.ts), so the user can edit it like any other skill. The
// hard output contract is BODY_OUTPUT_CONTRACT in lib/email/draftBody.ts and
// is appended after it.

/**
 * Linear has exactly one connected account per deployment — no OAuth, no
 * label to disambiguate — so a provider lookup is enough. Unlike Gmail's
 * resolveAccountIds, there is nothing to pick between.
 */
/** Linear's OWN scale, 0-4 — see the note on LINEAR_PRIORITY in catalog.ts.
 *  Duplicated from outcomes.ts deliberately: this file must not import the
 *  renderer, and four strings are cheaper than the coupling. */
const LINEAR_PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

export async function linearApiKey(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const account = accounts.find((a) => a.provider === "linear");
  if (!account) {
    throw new Error(
      "No Linear account connected. Run `bunx convex run debug:connectLinear` " +
        "once to seal LINEAR_API_KEY into a connectedAccounts row.",
    );
  }
  if (account.status !== "ACTIVE") {
    // Say it, never fall back: a task written anywhere but Linear is lost.
    throw new Error(
      `Linear is connected but marked ${account.status}, so I can't reach your board. ` +
        "Re-run `bunx convex run debug:connectLinear '{}'` with a fresh LINEAR_API_KEY.",
    );
  }
  // Keys sealed before 2026-10-15 were not cleaned; a stray newline is a 401.
  return cleanLinearKey(
    await open({
      ciphertext: account.encryptedCredentials,
      iv: account.credentialIv,
      authTag: account.credentialAuthTag,
    }),
  );
}

/**
 * Turn a batch of proposed Linear writes into one stored changeset, one
 * approval, and one card.
 *
 * Shared by linear.propose_changeset (which builds its batch from an explicit
 * tool call) and flushStagedWrites (which builds it from whatever task.* did
 * this turn). Both need the identical guarantee: the hash is of the RESOLVED
 * entries — state names already turned into ids, labels already turned into
 * ids — so a re-proposal that resolves differently gets a different approval,
 * and an entry edited after the card was sent voids it.
 */
async function openChangesetApproval(
  ctx: ActionCtx,
  userId: Id<"users">,
  timezone: string,
  entries: ChangesetEntry[],
  displays: string[],
  summary: string,
) {
  const hash = await changesetPayloadHash(entries);
  const changesetId = changesetIdFromHash(hash);

  // Reused, not a new table — see resolveChangeset's comment below.
  await ctx.runMutation(internal.model.preferences.set, {
    userId,
    key: `linear_changeset:${changesetId}`,
    value: { changes: entries, summary, createdAt: Date.now() },
  });

  // The approval desk opens with the proposal, exactly as it does for a
  // draft — the batch and the button that applies it arrive together, so
  // there is no window where the user has been shown something they cannot
  // act on.
  const approval = await ctx.runMutation(internal.model.approvals.create, {
    userId,
    action: "linear.apply_changeset",
    targetType: "linear_changesets",
    targetId: changesetId,
    payloadHash: hash,
  });

  const user = await ctx.runQuery(internal.model.users.get, { userId });
  if (user) {
    const lines = [
      `<b>📋 Linear — ${escapeTelegramHtml(summary)}</b>`,
      ``,
      ...displays.map((d, n) => `${n + 1}. ${escapeTelegramHtml(d)}`),
      ``,
      `Applies ${entries.length} change${entries.length === 1 ? "" : "s"} in one go. ` +
        `Expires ${escapeTelegramHtml(formatInstant(approval.expiresAt, timezone))}.`,
    ];

    await sendCard(user.telegramId, alreadyHtml(lines.join("\n")), [
      [
        { text: "Apply", data: `applyset:${changesetId}` },
        { text: "Discard", data: `discardset:${changesetId}` },
      ],
    ]);
  }

  return { changesetId, approvalExpiresAt: formatInstant(approval.expiresAt, timezone) };
}

/**
 * The open Linear issues, in the shape the planning prompt wants.
 *
 * Exported because assistant.ts needs it BEFORE any tool runs — the model has
 * to see the ids to act on them in the same turn, and there is only one batch
 * of tool calls per message. Throws on a Linear outage rather than returning
 * an empty list: an empty board and an unreachable one are different facts,
 * and only one of them should be shown to the user as "no open tasks".
 */
export async function listOpenLinearIssues(
  ctx: ActionCtx,
  userId: Id<"users">,
  limit = 15,
): Promise<{ taskId: string; title: string; status: string; project?: string; dueAt?: string }[]> {
  const apiKey = await linearApiKey(ctx, userId);
  const { issues } = await listAllIssues(apiKey, { stateTypes: OPEN_STATE_TYPES }, limit);
  return issues.map((i) => ({
    taskId: i.identifier,
    title: i.title,
    status: i.state.name,
    ...(i.project?.name ? { project: i.project.name } : {}),
  }));
}

/**
 * Every Linear issue matching a task-level filter, all pages.
 *
 * A project name is tried as a Linear Project first, then as a label —
 * the owner has used both for "project" over time, and a filter that only
 * knew one of them would report an empty project that is not empty.
 */
async function findLinearIssues(
  apiKey: string,
  filter: {
    status?: TaskStatus;
    includeDone?: boolean;
    projectName?: string;
    noProject?: boolean;
    teamKey?: string;
  },
): Promise<{ issues: LinearIssueSummary[]; truncated: boolean; matchedBy?: "project" | "label" }> {
  const stateTypes = stateTypesForFilter(filter.status, filter.includeDone === true);
  const base = { teamKey: filter.teamKey, ...(stateTypes ? { stateTypes } : {}) };

  if (filter.projectName) {
    const byProject = await listAllIssues(apiKey, { ...base, projectName: filter.projectName });
    if (byProject.issues.length > 0) return { ...byProject, matchedBy: "project" };
    const byLabel = await listAllIssues(apiKey, { ...base, labelName: filter.projectName });
    return { ...byLabel, matchedBy: byLabel.issues.length > 0 ? "label" : undefined };
  }
  return await listAllIssues(apiKey, { ...base, noProject: filter.noProject });
}

/** Re-read each updated issue and compare its state with what was asked. */
async function verifyStates(
  apiKey: string,
  updates: LinearIssueChange[],
): Promise<{ checked: number; matched: number; mismatched: { identifier: string; state: string }[] }> {
  const wanted = updates.filter((u) => u.stateId !== undefined);
  if (wanted.length === 0) return { checked: 0, matched: 0, mismatched: [] };
  const { issues } = await listAllIssues(apiKey, { ids: wanted.map((u) => u.issueId) }, 250);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const mismatched: { identifier: string; state: string }[] = [];
  for (const u of wanted) {
    const now = byId.get(u.issueId);
    if (!now || now.state.id !== u.stateId) {
      mismatched.push({ identifier: now?.identifier ?? u.issueId, state: now?.state.name ?? "not found" });
    }
  }
  return { checked: wanted.length, matched: wanted.length - mismatched.length, mismatched };
}

/**
 * The same open issues, but carrying their descriptions.
 *
 * Separate from listOpenLinearIssues because a description is only needed for
 * /blocked, and Linear's list query returning one per issue on every planning
 * turn would be a lot of prompt-adjacent bytes fetched for nothing.
 */
export async function listOpenLinearIssuesWithDescriptions(
  ctx: ActionCtx,
  userId: Id<"users">,
  limit = 25,
): Promise<{ identifier: string; title: string; description?: string | null }[]> {
  const apiKey = await linearApiKey(ctx, userId);
  const { issues: open } = await listAllIssues(apiKey, { stateTypes: OPEN_STATE_TYPES }, limit);

  const out: { identifier: string; title: string; description?: string | null }[] = [];
  for (const issue of open) {
    const full = await getIssue(apiKey, issue.id);
    out.push({
      identifier: issue.identifier,
      title: issue.title,
      description: full?.description,
    });
  }
  return out;
}

/**
 * Called ONCE after a turn's tool loop, with everything task.* staged.
 *
 * One card for the turn, not one per tool call: "add three tasks and close
 * ENG-12" is a single intention and should cost a single tap. Returns null
 * when nothing was staged, which is every turn on the Convex backend.
 */
export async function flushStagedWrites(
  ctx: ActionCtx,
  toolCtx: ToolContext,
): Promise<{ changesetId: string; count: number } | null> {
  const staged = toolCtx.staged;
  if (!staged || staged.length === 0) return null;

  const summary =
    staged.length === 1 ? "1 change" : `${staged.length} changes`;

  const { changesetId } = await openChangesetApproval(
    ctx,
    toolCtx.userId,
    toolCtx.timezone,
    staged.map((w) => w.entry),
    staged.map((w) => w.display),
    summary,
  );

  // Cleared so a retry of the same turn cannot double-stage.
  toolCtx.staged = [];
  return { changesetId, count: staged.length };
}

const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/**
 * A Google account that actually granted `scope`, plus a fresh access token.
 *
 * Calendar and Drive ride the SAME grant as Gmail — one Google account, one
 * refresh token, one row. So this is not "find the calendar account", it is
 * "find a Google account whose stored scopes include this capability".
 *
 * The scope check is the load-bearing part. Google does not retroactively
 * add a scope to a token issued without it, so every account connected
 * before Phase 10 has a perfectly valid token that cannot touch the
 * calendar. Without this check the failure surfaces as a raw 403 from deep
 * inside a fetch; with it, the user is told the one thing that fixes it.
 */
async function googleAccountFor(ctx: ActionCtx, userId: Id<"users">, scope: string) {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const gmail = accounts.filter((acc) => acc.provider === "gmail" && acc.status === "ACTIVE");

  if (gmail.length === 0) {
    throw new Error("No Google account connected. Send /connect <label> to add one.");
  }

  const granted = gmail.find((acc) => acc.scopesGranted.includes(scope));
  if (!granted) {
    const capability = scope.includes("calendar") ? "Calendar" : "Drive";
    throw new Error(
      `None of your connected Google accounts has ${capability} access yet. ` +
        `${capability} was added after they were connected, and Google cannot ` +
        `grant it to an existing token — send /reconnect <your address> once ` +
        `and it will be included.`,
    );
  }

  const accessToken = await ctx.runAction(internal.gmail.accessTokenForAccount, {
    accountId: granted._id,
  });
  return { accessToken, account: granted };
}

/**
 * EVERY active Google account holding `scope`. googleAccountFor above picks
 * one, which was right for creating an event (it has to live somewhere) and
 * wrong for reading: "am I free Thursday" answered from one calendar out of
 * three is a confident wrong answer.
 */
async function googleAccountsFor(ctx: ActionCtx, userId: Id<"users">, scope: string) {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const gmail = accounts.filter((acc) => acc.provider === "gmail" && acc.status === "ACTIVE");
  if (gmail.length === 0) {
    throw new Error("No Google account connected. Send /connect <label> to add one.");
  }
  const granted = gmail.filter((acc) => acc.scopesGranted.includes(scope));
  if (granted.length === 0) {
    throw new Error(
      "None of your connected Google accounts has Calendar access yet. Send " +
        "/reconnect <your address> once and it will be included.",
    );
  }
  return granted;
}

export interface OwnedEvent {
  event: CalendarEvent;
  calendarOf: string;
}

/**
 * Events in a window from every connected calendar, merged and de-duplicated.
 * One calendar failing (an expired token) is reported, not fatal — the others
 * still answer, and the reply says which one could not be read.
 */
export async function allCalendarEvents(
  ctx: ActionCtx,
  userId: Id<"users">,
  win: { startMs: number; endMs: number },
  options: { query?: string; limit?: number } = {},
): Promise<{ events: OwnedEvent[]; calendars: string[]; failures: string[] }> {
  const accounts = await googleAccountsFor(ctx, userId, CALENDAR_READ_SCOPE);
  const events: OwnedEvent[] = [];
  const failures: string[] = [];

  for (const account of accounts) {
    try {
      const accessToken = await ctx.runAction(internal.gmail.accessTokenForAccount, {
        accountId: account._id,
      });
      const items = await listEvents(accessToken, {
        timeMinIso: new Date(win.startMs).toISOString(),
        timeMaxIso: new Date(win.endMs).toISOString(),
        limit: options.limit ?? 25,
        query: options.query,
      });
      for (const event of items) events.push({ event, calendarOf: account.accountEmail });
    } catch (error) {
      failures.push(`${account.accountEmail}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The same meeting on two of your calendars is one meeting.
  const seen = new Set<string>();
  const unique = events.filter(({ event }) => {
    const key = `${(event.summary ?? "").trim().toLowerCase()}|${event.start.dateTime ?? event.start.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((x, y) =>
    String(x.event.start.dateTime ?? x.event.start.date).localeCompare(
      String(y.event.start.dateTime ?? y.event.start.date),
    ),
  );

  return { events: unique, calendars: accounts.map((acc) => acc.accountEmail), failures };
}

export function toCalendarItems(events: OwnedEvent[], timezone: string): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const { event, calendarOf } of events) {
    const startMs = whenToMs(event.start, timezone);
    const endMs = displayEndMs(event, timezone);
    if (startMs === null || endMs === null) continue;
    items.push({
      title: event.summary ?? "(no title)",
      startMs,
      endMs,
      calendarOf,
      allDay: isAllDay(event.start),
    });
  }
  return items;
}

const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** How much of a document reaches a prompt. Beyond this it is a cost, not
 *  context — and the truncation is announced, never silent. */
const DRIVE_TEXT_CAP = 20_000;

/** The model picks a WORD; the mime type is looked up here. */
const DRIVE_KINDS: Record<string, string | undefined> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  folder: "application/vnd.google-apps.folder",
};

function summarizeFile(file: DriveFile, timezone: string) {
  const modifiedMs = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  return {
    fileId: file.id,
    title: file.name,
    kind: fileKind(file.mimeType),
    // The modified date is not decoration. "Find my latest CV" is answered
    // by the DATE as much as by the name, and a list of three CVs without
    // dates is not a list the user can choose from.
    modifiedAt: Number.isNaN(modifiedMs) ? undefined : formatInstant(modifiedMs, timezone),
    owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress,
    link: file.webViewLink,
  };
}

/** One calendar event, in the shape the renderer and the model both want. */
function summarizeEvent(
  event: CalendarEvent,
  timezone: string,
  selfEmails: string[],
  calendarOf?: string,
) {
  const startMs = whenToMs(event.start, timezone);
  const endMs = displayEndMs(event, timezone);

  return {
    eventId: event.id,
    ...(calendarOf ? { calendarOf } : {}),
    title: event.summary ?? "(no title)",
    allDay: isAllDay(event.start),
    startsAt: startMs === null ? undefined : formatInstant(startMs, timezone),
    endsAt: endMs === null ? undefined : formatInstant(endMs, timezone),
    startMs: startMs ?? undefined,
    location: event.location,
    guests: otherAttendees(event, selfEmails),
    link: event.htmlLink,
  };
}

/**
 * Which store owns tasks right now — a fact about the database, never a
 * judgement the model makes. See lib/tasks/backend.ts.
 */
async function taskBackend(ctx: ActionCtx, userId: Id<"users">) {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const linear = accounts.find((a) => a.provider === "linear");
  return { backend: backendForAccounts(accounts), linear };
}

/**
 * The team a new issue is born into.
 *
 * LINEAR_TEAM_KEY when set. Otherwise, if the key can see exactly one team,
 * that one — the single-team workspace is the common case and asking about it
 * would be pedantry. With several teams and no configured default it REFUSES
 * and names them, because filing an issue on the wrong team is a task the
 * user will not find again, and a guess here is a coin flip.
 */
async function resolveTeam(apiKey: string, teamKey?: string) {
  const teams = await listTeams(apiKey);
  if (teams.length === 0) throw new Error("This Linear key can see no teams.");

  const wanted = teamKey ?? process.env.LINEAR_TEAM_KEY;
  if (wanted) {
    const match = teams.find((t) => t.key.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      throw new Error(
        `No Linear team with key "${wanted}" (has: ${teams.map((t) => t.key).join(", ")})`,
      );
    }
    return match;
  }

  if (teams.length === 1) return teams[0]!;
  throw new Error(
    `Which team? This key sees ${teams.map((t) => t.key).join(", ")} — ` +
      `set LINEAR_TEAM_KEY, or say which one.`,
  );
}

/**
 * Label names to label ids, creating any that do not exist yet.
 *
 * A project IS a label here, per the owner's convention, so this is the path
 * every "add a task for the pa project" takes. Creation is reported back
 * rather than done quietly: a typo that silently mints "Ivnoices" alongside
 * "Invoices" splits a board in a way nobody notices for weeks.
 */
async function resolveLabelIds(
  apiKey: string,
  teamId: string,
  wanted: string[],
): Promise<{ ids: string[]; created: string[] }> {
  if (wanted.length === 0) return { ids: [], created: [] };

  const existing = await listLabels(apiKey);
  const { ids, missing } = matchLabels(existing, wanted);
  const created: string[] = [];

  for (const name of missing) {
    const label = await createLabel(apiKey, name, teamId);
    if (label) {
      ids.push(label.id);
      created.push(label.name);
    }
  }

  return { ids, created };
}

/**
 * Find the Linear issue a task.* call is about.
 *
 * The model supplies `taskId` (which on this backend is an identifier like
 * ENG-123) or `taskTitle` — words, never a Linear UUID it invented. Same rule
 * and same shape as tasks.findByTitle and emailMessages.findByFragment.
 */
async function resolveLinearIssue(apiKey: string, args: Record<string, unknown>) {
  const ref = typeof args.taskId === "string" && args.taskId.length > 0 ? args.taskId : undefined;

  if (ref) {
    const direct = await getIssue(apiKey, ref);
    if (direct) return direct;
  }

  const title =
    (typeof args.taskTitle === "string" && args.taskTitle.length > 0 ? args.taskTitle : undefined) ??
    ref;
  if (!title) throw new Error("no taskId or taskTitle given");

  const matches = await searchIssues(apiKey, title, 5);
  const open = matches.filter((m) => m.state.type !== "completed" && m.state.type !== "canceled");
  const best = open[0] ?? matches[0];
  if (!best) throw new Error(`no Linear issue matching "${title}"`);

  // searchIssues returns a summary; the update path needs the description and
  // the team, so re-read the one that matched.
  const full = await getIssue(apiKey, best.id);
  if (!full) throw new Error(`no Linear issue matching "${title}"`);
  return full;
}

/**
 * Stage one Linear write for this turn's single approval.
 *
 * Nothing here touches Linear. That is the point — see the note on
 * ToolContext.staged.
 */
function stage(toolCtx: ToolContext, entry: ChangesetEntry, display: string) {
  const staged = (toolCtx.staged ??= []);
  staged.push({ entry, display });
  return { staged: true, pending: staged.length, change: display };
}

/**
 * Resolve the issue a task.* call is about, work out what changes, and stage
 * it. Shared by task.update / complete / block / unblock, which differ only
 * in what they want changed.
 */
async function stageLinearUpdate(
  ctx: ActionCtx,
  toolCtx: ToolContext,
  args: Record<string, unknown>,
  wanted: {
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: number;
    blockerReason?: string;
    clearBlocker?: boolean;
  },
) {
  const apiKey = await linearApiKey(ctx, toolCtx.userId);
  const issue = await resolveLinearIssue(apiKey, args);

  const parts: string[] = [];
  const entry: ChangesetEntry = { op: "update", issueId: issue.id };

  if (wanted.title !== undefined) {
    entry.title = wanted.title;
    parts.push(`title → "${wanted.title}"`);
  }

  const linearPriority = linearPriorityForInternal(wanted.priority);
  if (linearPriority !== undefined) {
    entry.priority = linearPriority;
    parts.push(`priority → ${LINEAR_PRIORITY_NAMES[linearPriority] ?? linearPriority}`);
  }

  // A blocker is a sentence, and Linear has no state that can hold one, so it
  // rides in the description. See withBlockerNote in lib/tasks/backend.ts.
  if (wanted.blockerReason) {
    entry.description = withBlockerNote(issue.description, wanted.blockerReason);
    parts.push(`blocked: ${wanted.blockerReason}`);
  } else if (wanted.clearBlocker) {
    entry.description = withoutBlockerNote(issue.description);
    parts.push("unblocked");
  } else if (wanted.description !== undefined) {
    entry.description = wanted.description;
    parts.push("description updated");
  }

  if (wanted.status) {
    const states = await listWorkflowStates(apiKey, issue.team.key);
    // The user's own words for a column win over the category mapping — they
    // know their board better than a five-value enum does.
    const named =
      typeof args.stateName === "string" && args.stateName
        ? resolveStateByName(states, args.stateName)
        : null;
    const target = named ?? resolveStateForStatus(states, wanted.status);
    if (!target) {
      throw new Error(
        `${issue.team.key} has no workflow state for ${wanted.status} ` +
          `(has: ${states.map((st) => st.name).join(", ")})`,
      );
    }
    entry.stateId = target.id;
    parts.push(`state → ${target.name}`);
  }

  if (parts.length === 0) throw new Error("nothing to change on that issue");

  // Applied NOW, not staged (2026-10-15). An edit to one existing issue on
  // the owner's own board is reversible and affects nobody else — the same
  // class as email.archive, which has never needed a tap. Staging it behind
  // an Apply card meant "mark THE-89 done" silently did nothing whenever the
  // card scrolled out of view, which is exactly the "it doesn't update my
  // task" the owner reported. Creates still batch for one tap.
  const [result] = await applyChangeset(apiKey, [
    {
      issueId: issue.id,
      title: entry.title,
      description: entry.description,
      stateId: entry.stateId,
      priority: entry.priority,
    },
  ]);
  if (!result?.success) {
    throw new Error(`Linear rejected the change to ${issue.identifier}: ${result?.error ?? "unknown error"}`);
  }

  return {
    applied: true,
    change: `${issue.identifier} — ${parts.join(", ")}`,
    previousState: issue.state?.name,
    taskId: issue.identifier,
    title: issue.title,
  };
}

/** How a Linear issue looks in the internal task vocabulary. */
function summarizeLinearIssue(issue: LinearIssueSummary) {
  return {
    taskId: issue.identifier,
    title: issue.title,
    status: statusForStateType(issue.state.type ?? ""),
    stateName: issue.state.name,
    ...(issue.project?.name ? { project: issue.project.name } : {}),
    priority: issue.priority,
    url: issue.url,
  };
}

/**
 * "Move it to Done" names a STATE, not an id — and different teams can
 * have differently-worded states, so this is resolved from the issue's own
 * team, in code, exactly like a taskTitle or projectName is resolved
 * before anything is written (I-3). The model never sees or invents a
 * Linear state id.
 */
async function resolveStateId(apiKey: string, issueRef: string, stateName: string): Promise<string> {
  const issue = await getIssue(apiKey, issueRef);
  if (!issue) throw new Error(`no Linear issue matching "${issueRef}"`);

  const states = await listWorkflowStates(apiKey, issue.team.key);
  const match = states.find((s) => s.name.toLowerCase() === stateName.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `${issue.team.key} has no workflow state named "${stateName}" ` +
        `(has: ${states.map((s) => s.name).join(", ")})`,
    );
  }
  return match.id;
}

async function toLinearChanges(
  apiKey: string,
  rawChanges: Array<Record<string, unknown>>,
): Promise<LinearIssueChange[]> {
  return await Promise.all(
    rawChanges.map(async (c) => ({
      issueId: c.issueRef as string,
      title: c.title as string | undefined,
      description: c.description as string | undefined,
      stateName: c.stateName as string | undefined,
      stateId:
        typeof c.stateName === "string" && c.stateName.length > 0
          ? await resolveStateId(apiKey, c.issueRef as string, c.stateName)
          : undefined,
      priority: c.priority as number | undefined,
    })),
  );
}

/**
 * The stored batch for a changesetId.
 *
 * The batch lives in `preferences` under a content-addressed key — reusing an
 * existing generic table rather than adding a new one, the same call
 * PHASE-05B's brief config makes for the same reason.
 */
async function resolveChangeset(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: Record<string, unknown>,
): Promise<ChangesetEntry[]> {
  const changesetId = args.changesetId;
  if (typeof changesetId !== "string" || changesetId.length === 0) {
    throw new Error("no changesetId given — propose the batch first");
  }

  const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
  const stored = rows.find((p) => p.key === `linear_changeset:${changesetId}`);
  if (!stored) throw new Error(`no proposed changeset "${changesetId}" — propose one first`);
  return (stored.value as { changes: ChangesetEntry[] }).changes;
}
