import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { TOOL_META } from "../lib/tools/catalog";
import type { ToolCall } from "../lib/tools/plan";
import { toEpochMs, formatInstant } from "../lib/time";
import { normalizeCategory } from "../lib/userContext";
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
}

export async function executeToolCall(
  ctx: ActionCtx,
  toolCtx: ToolContext,
  call: ToolCall,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const meta = TOOL_META[call.name];

  // Phase 2 has no approval flow yet, and no consequential tool. When Phase 6
  // adds email.send, this is the gate it has to pass — the refusal exists
  // before the capability does, not after.
  if (meta.consequential) {
    await audit(ctx, call, "denied", startedAt, "consequential tool without approval");
    return {
      name: call.name,
      ok: false,
      result: { error: "This action needs your explicit approval, which is not built yet." },
    };
  }

  try {
    const result = await dispatch(ctx, toolCtx, call);
    await audit(ctx, call, "ok", startedAt);
    return { name: call.name, ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, call, "error", startedAt, message);
    return { name: call.name, ok: false, result: { error: message } };
  }
}

async function audit(
  ctx: ActionCtx,
  call: ToolCall,
  result: "ok" | "denied" | "error",
  startedAt: number,
  errorMessage?: string,
) {
  await ctx.runMutation(internal.model.audit.record, {
    // The proposal came from the model. Recording that distinctly from a
    // direct user action is what makes the log answer "why did it do that?".
    actor: "llm_proposed",
    action: call.name,
    args: call.args,
    result,
    errorMessage: errorMessage?.slice(0, 500),
    latencyMs: Date.now() - startedAt,
  });
}

/**
 * Turn `{ taskId? , taskTitle? }` into a concrete id.
 *
 * Titles are resolved through a query, in code — never by handing the model's
 * string to a mutation and hoping. A title that matches nothing is an error
 * the user sees, not a silently skipped action.
 */
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
  { userId, timezone }: ToolContext,
  call: ToolCall,
): Promise<unknown> {
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
      // Resolve the project by NAME here, in code. The model never hands us a
      // project id and we never look one up on its say-so.
      let projectId: Id<"projects"> | undefined;
      if (typeof a.projectName === "string" && a.projectName.length > 0) {
        const upserted = await ctx.runMutation(internal.model.projects.upsert, {
          userId,
          name: a.projectName,
        });
        projectId = upserted.projectId;
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
      const tasks = await ctx.runQuery(internal.model.tasks.list, {
        userId,
        status: a.status as string | undefined,
        limit: (a.limit as number | undefined) ?? 15,
      });
      return tasks.map(summarizeTask(timezone));
    }

    case "task.update":
      return await ctx.runMutation(internal.model.tasks.update, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
        title: a.title as string | undefined,
        detail: a.detail as string | undefined,
        status: a.status as string | undefined,
        priority: a.priority as number | undefined,
        dueAt: instant(a.dueAt),
      });

    case "task.complete":
      return await ctx.runMutation(internal.model.tasks.complete, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
      });

    case "task.block": {
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

    case "task.unblock":
      return await ctx.runMutation(internal.model.tasks.unblock, {
        userId,
        taskId: await resolveTaskId(ctx, userId, a),
      });

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

    case "email.list_recent": {
      const accountIds = await resolveAccountIds(ctx, userId, a.accountLabel);
      if (accountIds.length === 0) return { connected: false };

      if (a.deep === true) {
        return await deepSearchAccounts(ctx, accountIds, {
          gmailLabel: a.gmailLabel as string | undefined,
        });
      }

      const rows = await ctx.runQuery(internal.model.emailMessages.search, {
        accountIds,
        gmailLabel: a.gmailLabel as string | undefined,
        limit: (a.limit as number | undefined) ?? 10,
      });
      return {
        connected: true,
        gmailLabel: a.gmailLabel,
        messages: rows.map((r) => summarizeEmail(r)),
      };
    }

    case "email.search": {
      const accountIds = await resolveAccountIds(ctx, userId, a.accountLabel);
      if (accountIds.length === 0) return { connected: false };

      if (a.deep === true) {
        return await deepSearchAccounts(ctx, accountIds, {
          query: a.query as string | undefined,
          gmailLabel: a.gmailLabel as string | undefined,
        });
      }

      const rows = await ctx.runQuery(internal.model.emailMessages.search, {
        accountIds,
        query: a.query as string | undefined,
        gmailLabel: a.gmailLabel as string | undefined,
        limit: (a.limit as number | undefined) ?? 10,
      });
      return {
        connected: true,
        query: a.query,
        gmailLabel: a.gmailLabel,
        messages: rows.map((r) => summarizeEmail(r)),
      };
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
      let message;
      if (a.emailMessageId) {
        message = await ctx.runQuery(internal.model.emailMessages.getById, {
          emailMessageId: a.emailMessageId as Id<"emailMessages">,
        });
      } else {
        // No id was given — resolve "that FairMoney email" by fragment,
        // scoped to the same accounts a search/list_recent would use.
        const accountIds = await resolveAccountIds(ctx, userId, a.accountLabel);
        message = await ctx.runQuery(internal.model.emailMessages.findByFragment, {
          accountIds,
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
        ...summarizeEmail(message, true),
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

/**
 * Runs `gmail.deepSearch` against every given account and merges the results.
 *
 * Deliberately sequential, not `Promise.all` — this is already the slow path
 * (a live Gmail call per message, not a cached read), and running N accounts
 * concurrently multiplies the load on a single inbound tool call rather than
 * spreading it the way the background sync's round-robin does.
 */
async function deepSearchAccounts(
  ctx: ActionCtx,
  accountIds: Id<"connectedAccounts">[],
  filters: { query?: string; gmailLabel?: string },
): Promise<unknown> {
  const allIds: string[] = [];
  for (const accountId of accountIds) {
    const found = await ctx.runAction(internal.gmail.deepSearch, {
      accountId,
      query: filters.query,
      gmailLabel: filters.gmailLabel,
    });
    allIds.push(...found.emailMessageIds);
  }

  const messages = [];
  for (const emailMessageId of allIds) {
    const message = await ctx.runQuery(internal.model.emailMessages.getById, {
      emailMessageId: emailMessageId as Id<"emailMessages">,
    });
    if (message) messages.push(summarizeEmail(message));
  }

  return {
    connected: true,
    deep: true,
    query: filters.query,
    gmailLabel: filters.gmailLabel,
    messages,
  };
}

async function resolveAccountIds(
  ctx: ActionCtx,
  userId: Id<"users">,
  label: unknown,
): Promise<Id<"connectedAccounts">[]> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
    userId,
  });
  const active = accounts.filter((acc) => acc.status === "ACTIVE");
  if (typeof label !== "string" || label.length === 0) return active.map((a) => a._id);

  const matched = active.filter((a) => a.label.toLowerCase() === label.toLowerCase());
  return matched.map((a) => a._id);
}

interface EmailLike {
  _id: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  labelIds: string[];
  receivedAt: number;
}

function summarizeEmail(message: EmailLike, full = false) {
  return {
    emailMessageId: message._id,
    from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
    subject: message.subject ?? "(no subject)",
    receivedAt: new Date(message.receivedAt).toISOString(),
    spam: message.labelIds.includes("SPAM"),
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
