// Pure. Turns executed tool results into the sentence the user reads.
//
// This replaces a second model call. The orchestrator used to run
// PLAN_TOOLS and then a compose call to narrate what the tools returned —
// two flash-tier requests per inbound message, which exhausted the free-tier
// quota after two or three messages.
//
// Rendering here is not just cheaper, it is MORE accurate: a model asked to
// retell a tool result can soften a failure or invent a due date. This cannot.

export interface ToolOutcome {
  name: string;
  ok: boolean;
  result: unknown;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

const str = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

export interface RejectedCall {
  name: string;
  reason: string;
}

/**
 * The plan's own `reply` is written BEFORE anything runs, so it is only
 * trustworthy when everything the model proposed actually happened.
 *
 * `rejected` calls never reach the router — they fail Zod validation in
 * parseToolPlan. They used to be logged and dropped, which produced the worst
 * possible output: "I've set up the project, created the task and scheduled
 * your reminder" when only the reminder existed. A rejection invalidates the
 * planned reply exactly as a failure does.
 */
export function renderOutcomes(
  plannedReply: string,
  outcomes: ToolOutcome[],
  rejected: RejectedCall[] = [],
): string {
  const lines = outcomes.map(renderOne);
  const skipped = rejected.map((r) => `⚠️ Couldn't do ${r.name} — ${r.reason}`);

  const trustworthy = outcomes.every((o) => o.ok) && rejected.length === 0;
  const preamble = trustworthy ? plannedReply.trim() : "";

  const body = [preamble, ...lines, ...skipped].filter(Boolean).join("\n").trim();

  // Something was proposed and nothing survived — say so rather than
  // returning an empty message.
  return body || "I understood that but couldn't act on it. Try rephrasing?";
}

function renderEmailList(r: unknown): string {
  if (field(r, "connected") === false) {
    return "No mailbox connected. I can send you a link to connect one — just ask.";
  }
  const rows = field(r, "messages");
  const messages = Array.isArray(rows) ? rows : [];
  const deep = field(r, "deep") === true;
  const scope = deep ? "your whole mailbox" : "the last 2 days";

  if (messages.length === 0) {
    const label = str(r, "gmailLabel");
    const query = str(r, "query");
    if (label) return `No emails labelled ${label} in ${scope}.`;
    if (query) return `Nothing matching "${query}" in ${scope}.`;
    return `Nothing in ${scope}.`;
  }

  return messages
    .map((m) => {
      const flag = field(m, "spam") === true ? " [SPAM]" : "";
      return `• ${str(m, "from") ?? "?"} — ${str(m, "subject") ?? "(no subject)"}${flag}\n    ${str(m, "snippet") ?? ""}`;
    })
    .join("\n");
}

function renderOne(outcome: ToolOutcome): string {
  if (!outcome.ok) {
    const error = str(outcome.result, "error") ?? "unknown error";
    return `⚠️ ${outcome.name} failed: ${error}`;
  }

  const r = outcome.result;

  switch (outcome.name) {
    case "task.create":
      return `✅ Task created: ${str(r, "title") ?? "(untitled)"}`;

    case "task.complete":
      return `✅ Completed: ${str(r, "title") ?? "task"}`;

    case "task.update":
      return "✏️ Task updated.";

    case "task.block":
      return "🚧 Marked blocked.";

    case "task.unblock":
      return "▶️ Unblocked — status is now RESUMED.";

    case "task.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "No tasks match.";
      return rows
        .map((t) => {
          const due = str(t, "dueAt");
          return `• ${str(t, "title") ?? "(untitled)"} — ${str(t, "status") ?? "?"}${
            due ? `, due ${due}` : ""
          }`;
        })
        .join("\n");
    }

    case "reminder.create":
      return `⏰ Reminder set for ${str(r, "scheduledFor") ?? "the requested time"}.`;

    case "reminder.cancel":
      return field(r, "cancelled") === true
        ? "🚫 Reminder cancelled."
        : `Nothing to cancel — that reminder is ${str(r, "reason") ?? "not pending"}.`;

    case "reminder.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "Nothing scheduled.";
      return rows
        .map((x) => `• ${str(x, "scheduledFor") ?? "?"} — ${str(x, "message") ?? ""}`)
        .join("\n");
    }

    case "memory.upsert_project":
      return field(r, "created") === true ? "📁 Project created." : "📁 Project updated.";

    case "memory.get_project": {
      if (field(r, "found") !== true) return "No project by that name.";
      const tasks = field(r, "tasks");
      const count = Array.isArray(tasks) ? tasks.length : 0;
      const objective = str(r, "objective");
      return [
        `📁 ${str(r, "name") ?? "project"} — ${str(r, "status") ?? "?"}`,
        objective ? `   ${objective}` : "",
        `   ${count} task${count === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "person.upsert":
      return field(r, "created") === true ? "👤 Person added." : "👤 Person updated.";

    case "account.connect_link":
      return [
        `Connect a mailbox as "${str(r, "label")}":`,
        String(field(r, "url")),
        "Read-only. The link works once and expires in 10 minutes.",
      ].join("\n");

    case "email.list_recent":
    case "email.search":
      return renderEmailList(r);

    case "email.get_message": {
      if (field(r, "found") !== true) {
        return "No email matching that — try naming the sender or a word from the subject.";
      }
      const body = str(r, "body") ?? "";
      // Telegram caps a message at 4096 UTF-16 units (channels/telegram.ts
      // truncates above that anyway). Leave headroom for the From/Subject
      // header lines above the body, rather than the old 800-char cap that
      // cut a message off after two sentences — "full content" should mean
      // full content up to what Telegram can actually display in one message.
      const BODY_CAP = 3500;
      const capped = body.length > BODY_CAP
        ? body.slice(0, BODY_CAP) + `\n\n[…truncated, ${body.length - BODY_CAP} more characters]`
        : body;
      return [
        `From: ${str(r, "from")}`,
        `Subject: ${str(r, "subject")}`,
        field(r, "spam") === true ? "(in Spam)" : "",
        "",
        capped || "(no body)",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "instruction.add":
      return `📝 Got it — I'll remember: "${str(r, "text") ?? ""}"`;

    case "instruction.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "No standing instructions saved.";
      return rows.map((x) => `• ${str(x, "text") ?? ""}`).join("\n");
    }

    case "instruction.remove":
      return field(r, "removed") === true
        ? "🗑️ Forgotten."
        : "Couldn't find an instruction matching that.";

    case "skill.update":
      return field(r, "created") === true
        ? `🧩 Skill "${str(r, "name") ?? ""}" saved.`
        : `🧩 Skill "${str(r, "name") ?? ""}" updated.`;

    case "skill.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "No skills.";
      return rows
        .map((x) => `• ${str(x, "name") ?? "?"}${field(x, "customized") === true ? " (customized)" : " (default)"}`)
        .join("\n");
    }

    case "skill.get": {
      if (field(r, "found") !== true) return `No skill named "${str(r, "name") ?? "?"}".`;
      return `${str(r, "title") ?? str(r, "name")}\n\n${str(r, "content") ?? ""}`;
    }

    default:
      return `✅ ${outcome.name}`;
  }
}
