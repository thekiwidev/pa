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

    case "email.create_draft": {
      // Deliberately does NOT include the body.
      //
      // The body lives on the CARD, rendered by deterministic code directly
      // above the [Send] button (see tools/router.ts). It got there because
      // this render is fed to the skill-compose pass as untrusted input, and
      // that pass summarised the draft away — leaving the user tapping Send
      // on text they had never read. Text an approval binds itself to must
      // reach the user through code, not through a model that may rewrite it.
      const toField = field(r, "to");
      const to = Array.isArray(toField) ? toField.join(", ") : "?";
      return [
        `📝 Draft ready for ${to} — ${str(r, "subject") ?? "(no subject)"}`,
        `The full text is on the card above. Tap Send or Discard.`,
        `Expires ${str(r, "approvalExpiresAt") ?? "soon"}.`,
      ].join("\n");
    }

    case "meeting.ingest": {
      const lines: string[] = [`📋 **${str(r, "title") ?? "Meeting"}**`, ""];

      const tldr = str(r, "personalTldr");
      if (tldr) lines.push(tldr, "");

      const section = (heading: string, items: unknown, bullet: string) => {
        if (!Array.isArray(items) || items.length === 0) return;
        lines.push(heading);
        for (const item of items) lines.push(`  ${bullet} ${String(item)}`);
        lines.push("");
      };

      section("**YOU OWE**", field(r, "youOwe"), "✅");
      section("**WAITING ON**", field(r, "waitingOn"), "🚧");

      // NEEDS YOUR CALL is not optional. Every commitment with no clear owner
      // lands here and creates NOTHING — that is the difference between a
      // system that quietly invents tasks and one you can hand a transcript
      // to. Rendered even when the model found none, so its absence means
      // "nothing was ambiguous" rather than "this section was dropped".
      const unknowns = field(r, "needsYourCall");
      if (Array.isArray(unknowns) && unknowns.length > 0) {
        lines.push("**NEEDS YOUR CALL** — nothing created for these");
        for (const item of unknowns) lines.push(`  ❓ ${String(item)}`);
        lines.push("");
      }

      const scheduling = field(r, "scheduling");
      if (Array.isArray(scheduling) && scheduling.length > 0) {
        lines.push("**MENTIONED, NOT SCHEDULED** — there is no calendar tool");
        for (const item of scheduling) lines.push(`  📅 ${String(item)}`);
        lines.push("");
      }

      section("**DECIDED**", field(r, "decisions"), "•");

      return lines.join("\n").trimEnd();
    }

    case "meeting.list": {
      const meetings = field(r, "meetings");
      if (!Array.isArray(meetings) || meetings.length === 0) {
        return "No meetings processed yet. Send me a transcript.";
      }
      return [
        `📋 ${meetings.length} recent meeting${meetings.length === 1 ? "" : "s"}:`,
        ...meetings.map((entry) => {
          const m = entry as Record<string, unknown>;
          const count = Number(m.taskCount ?? 0);
          return `  • ${String(m.title)} — ${String(m.occurredAt)}${
            count > 0 ? `, ${count} task${count === 1 ? "" : "s"}` : ""
          }`;
        }),
      ].join("\n");
    }

    case "meeting.get": {
      const lines = [
        `📋 **${str(r, "title") ?? "Meeting"}** — ${str(r, "occurredAt") ?? ""}`,
        "",
        str(r, "personalTldr") ?? "",
      ];
      const decisions = field(r, "decisions");
      if (Array.isArray(decisions) && decisions.length > 0) {
        lines.push("", "**DECIDED**", ...decisions.map((d) => `  • ${String(d)}`));
      }
      return lines.join("\n").trimEnd();
    }

    case "email.add_rule":
      return field(r, "created") === true
        ? `✅ Rule saved: ${str(r, "description")}.\nIt applies from the next email in, before anything is read.`
        : `Already had that rule: ${str(r, "description")}.`;

    case "email.list_rules": {
      const rules = field(r, "rules");
      if (!Array.isArray(rules) || rules.length === 0) {
        return "No mail rules yet. Say something like \"ignore security alerts from Google\".";
      }
      return [
        `📋 ${rules.length} mail rule${rules.length === 1 ? "" : "s"}:`,
        ...rules.map((entry) => {
          const rule = entry as Record<string, unknown>;
          const because = typeof rule.reason === "string" && rule.reason ? ` — ${rule.reason}` : "";
          return `  • ${String(rule.description ?? "?")}${because}`;
        }),
      ].join("\n");
    }

    case "email.remove_rule":
      return field(r, "removed") === true
        ? "✅ Rule removed."
        : "No rule matched that — try `email.list_rules` to see them.";

    case "email.discard_draft":
      return field(r, "discarded") === true ? "🗑️ Draft discarded." : "Nothing to discard.";

    case "email.send_reply": {
      if (field(r, "awaitingApproval") === true) {
        const expires = str(r, "expiresAt");
        return expires
          ? `⏳ Tap Send on the card to confirm — expires ${expires}.`
          : "⏳ Tap Send on the card to confirm.";
      }
      return field(r, "sent") === true
        ? "✅ Sent."
        : `⚠️ Not sent: ${str(r, "error") ?? "unknown reason"}`;
    }

    case "email.summarize_thread":
      if (field(r, "found") !== true) return "No email matching that id.";
      return `📝 ${str(r, "summary") ?? "(no summary)"}`;

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

    case "brief.configure": {
      if (field(r, "enabled") !== true) return "🌅 Morning brief turned off.";
      const time = str(r, "timeOfDay") ?? "?";
      const next = str(r, "nextAt");
      const notes = str(r, "notes");
      return [
        `🌅 Morning brief on, daily at ${time}.`,
        next ? `Next one: ${next}.` : "",
        notes ? `Notes: ${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "brief.preview":
      return str(r, "text") ?? "(nothing to show)";

    case "context.set":
      return field(r, "created") === false
        ? "🧠 Already knew that."
        : `🧠 Noted: ${str(r, "text") ?? ""}`;

    case "context.list": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "I don't know anything about you yet.";
      return rows
        .map((x) => `• [${str(x, "category") ?? "other"}] ${str(x, "text") ?? ""}`)
        .join("\n");
    }

    case "context.remove":
      return field(r, "removed") === true
        ? `🗑️ Forgotten: ${str(r, "text") ?? ""}`
        : "Couldn't find anything matching that.";

    default:
      return `✅ ${outcome.name}`;
  }
}
