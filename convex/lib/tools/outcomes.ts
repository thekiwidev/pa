// Pure. Turns executed tool results into the sentence the user reads.
//
// This replaces a second model call. The orchestrator used to run
// PLAN_TOOLS and then a compose call to narrate what the tools returned —
// two flash-tier requests per inbound message, which exhausted the free-tier
// quota after two or three messages.
//
// Rendering here is not just cheaper, it is MORE accurate: a model asked to
// retell a tool result can soften a failure or invent a due date. This cannot.

import { returnsUnknowableContent } from "./catalog";
import { IMPORTANCE_ICON } from "../email/classification";
import { nextRung } from "../email/gmailQuery";
import { formatDay, formatDayTime } from "../time";
import { renderSavedItem, type SavedItemView } from "../saved/extract";

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
  /** For rendering instants in the owner's own clock. UTC is a safe default
   *  for the many callers whose outcomes carry no date at all. */
  timezone = "UTC",
): string {
  const lines = outcomes.map((outcome) => renderOne(outcome, timezone));
  const skipped = rejected.map((r) => `⚠️ Couldn't do ${r.name} — ${r.reason}`);

  // The planned reply is written BEFORE any tool runs, so it is only ever
  // safe to show when the model could actually have known what it was saying.
  // For tools returning external content it cannot — and it will confabulate
  // fluently rather than wait. See ToolMeta.contentIsUnknowable.
  const guessing = outcomes.some((o) => returnsUnknowableContent(o.name));
  const trustworthy = outcomes.every((o) => o.ok) && rejected.length === 0 && !guessing;
  const preamble = trustworthy ? plannedReply.trim() : "";

  const body = [preamble, ...lines, ...skipped].filter(Boolean).join("\n").trim();

  // Something was proposed and nothing survived — say so rather than
  // returning an empty message.
  return body || "I understood that but couldn't act on it. Try rephrasing?";
}

/** Linear's OWN scale, 0-4 — see the note on LINEAR_PRIORITY in catalog.ts. */
const LINEAR_PRIORITY_WORDS = ["No priority", "Urgent", "High", "Medium", "Low"];

function linearPriorityWord(p: unknown): string {
  return typeof p === "number" && LINEAR_PRIORITY_WORDS[p] ? LINEAR_PRIORITY_WORDS[p]! : "?";
}

function renderLinearIssueRow(m: unknown): string {
  const state = str(field(m, "state"), "name") ?? "?";
  const assigneeName = str(field(m, "assignee"), "name");
  return (
    `• ${str(m, "identifier") ?? "?"} — ${str(m, "title") ?? "(untitled)"} ` +
    `[${state}, ${linearPriorityWord(field(m, "priority"))}]` +
    (assigneeName ? ` — ${assigneeName}` : "")
  );
}

/**
 * What was actually searched for, in the user's own terms.
 *
 * Every empty result has to say this. "Nothing found" without naming the
 * scope invites the reader to conclude the mail does not exist, when what
 * actually happened is that a two-day local cache was checked.
 */
function describeCriteria(r: unknown): string {
  const parts: string[] = [];
  const from = str(r, "from");
  const subject = str(r, "subject");
  const query = str(r, "query");
  const label = str(r, "gmailLabel");
  if (from) parts.push(`from ${from}`);
  if (subject) parts.push(`with "${subject}" in the subject`);
  if (query) parts.push(`matching "${query}"`);
  if (label) parts.push(`labelled ${label}`);
  return parts.join(", ");
}

/** "primary", or "primary and work", or "" when only one mailbox exists. */
function describeMailboxes(r: unknown): string {
  const raw = field(r, "searchedMailboxes");
  const boxes = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  if (boxes.length === 0) return "";
  if (boxes.length === 1) return boxes[0]!;
  return `${boxes.slice(0, -1).join(", ")} and ${boxes[boxes.length - 1]}`;
}

function describeWindow(r: unknown, timezone: string): string {
  const within = field(r, "withinDays");
  const after = field(r, "afterDays");
  const from = field(r, "searchedFrom");
  const to = field(r, "searchedTo");

  if (typeof from === "number" && typeof to === "number") {
    const range = `${formatDay(from, timezone)} – ${formatDay(to, timezone)}`;
    return typeof after === "number" && after > 0
      ? `${range} (${after}–${String(within)} days ago)`
      : `${range} (last ${String(within)} days)`;
  }
  return `the last ${typeof within === "number" ? within : 2} days`;
}

/**
 * The sentence that makes a search resumable.
 *
 * Widening used to be the model's problem, and it solved it by throwing away
 * every filter and asking Gmail for everything — 25 unrelated messages in
 * answer to "find the one from Paul". Naming the next rung here turns "keep
 * looking" into a specific, non-overlapping follow-up query instead.
 */
function offerNextRung(r: unknown): string {
  const within = field(r, "withinDays");
  const current = typeof within === "number" ? within : 2;
  const next = nextRung(current);
  if (next === null) {
    return `That is as far back as I search — ${current} days.`;
  }
  return `Want me to keep looking, back to ${next} days?`;
}

function renderEmailList(r: unknown, timezone: string): string {
  if (field(r, "connected") === false) {
    return "No mailbox connected. I can send you a link to connect one — just ask.";
  }

  // "You have no mailbox called that" is a DIFFERENT fact from "you have no
  // mailbox", and the two used to render identically. Saying "No mailbox
  // connected" about mailboxes that are connected and syncing is a false
  // statement about the user's own data, and one they cannot check.
  const unknownLabel = str(r, "unknownLabel");
  if (unknownLabel !== undefined) {
    const raw = field(r, "available");
    const available = Array.isArray(raw) ? raw.join(", ") : "";
    return (
      `You have no mailbox labelled "${unknownLabel}".` +
      (available ? ` You have: ${available}.` : "")
    );
  }

  const rows = field(r, "messages");
  const messages = Array.isArray(rows) ? rows : [];
  const window = describeWindow(r, timezone);
  const mailboxes = describeMailboxes(r);
  const where = mailboxes ? ` in **${mailboxes}**` : "";

  if (messages.length === 0) {
    const criteria = describeCriteria(r);
    const what = criteria ? `No mail ${criteria}` : "No mail";
    return `${what}${where}, ${window}.\n\n${offerNextRung(r)}`;
  }

  const header =
    `**${messages.length} email${messages.length === 1 ? "" : "s"}**` +
    `${mailboxes ? ` · ${mailboxes}` : ""} · ${window}`;

  // A blank line between entries, and the sender, subject, date and mailbox
  // each on their own line. The old single-line-plus-indent shape ran every
  // result together, so a ten-message list read as one paragraph of noise.
  const entries = messages.map((m, index) => {
    const icon = IMPORTANCE_ICON[str(m, "importance") ?? ""] ?? "";
    const spam = field(m, "spam") === true ? " ⚠️ SPAM" : "";
    const receivedAt = field(m, "receivedAtMs");
    const when =
      typeof receivedAt === "number" ? formatDayTime(receivedAt, timezone) : str(m, "receivedAt");
    const box = str(m, "accountLabel");
    const snippet = (str(m, "snippet") ?? "").trim();

    return [
      `${icon ? `${icon} ` : ""}**${index + 1}. ${str(m, "from") ?? "?"}**${spam}`,
      str(m, "subject") ?? "(no subject)",
      `${when ?? ""}${box ? ` · ${box}` : ""}`,
      snippet ? snippet.slice(0, SNIPPET_CAP) : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [header, ...entries].join("\n\n");
}

/** Gmail's own preview is ~200 chars; anything longer is the body leaking. */
const SNIPPET_CAP = 200;

/** Telegram caps a message at 4096; leave room for the header lines. */
const DRIVE_RENDER_CAP = 3500;

/** The window enum, in words a sentence can use. */
const WINDOW_WORDS: Record<string, string> = {
  today: "today",
  rest_of_today: "for the rest of today",
  tomorrow: "tomorrow",
  week: "this week",
  next_week: "next week",
};

/** "today", "next week", or "on 2026-10-22" for a specific date. */
function windowWords(window: string | undefined): string {
  const w = window ?? "today";
  return WINDOW_WORDS[w] ?? `on ${w}`;
}

/** A calendar that could not be read is said out loud, never silently skipped. */
function couldNotRead(r: unknown): string {
  const rows = field(r, "couldNotRead");
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return `\n\n⚠️ Couldn't read: ${rows.join("; ")}`;
}

function renderOne(outcome: ToolOutcome, timezone: string): string {
  // "Waiting for your tap" is not a failure, even though the outcome is
  // ok:false — executeToolCall marks a consequential call ok:false precisely
  // BECAUSE it did not execute. This early return used to swallow that and
  // print "unknown error", which made a correctly-working approval gate look
  // broken. Affected email.send_reply too, not just Linear.
  const awaiting = field(outcome.result, "awaitingApproval") === true;

  if (!outcome.ok && !awaiting) {
    const error = str(outcome.result, "error") ?? "unknown error";
    return `⚠️ ${outcome.name} failed: ${error}`;
  }

  const r = outcome.result;

  switch (outcome.name) {
    // On the Linear backend a task tool STAGES rather than writes, so saying
    // "created" here would be a lie until the card is tapped. The staged
    // line names what will happen, and the approval card that follows is
    // what makes it happen.
    case "task.create":
      if (field(r, "staged") === true) {
        const created = field(r, "createdLabels");
        const newLabels = Array.isArray(created) && created.length > 0
          ? `\n🏷️ New label${created.length === 1 ? "" : "s"}: ${created.join(", ")}`
          : "";
        return `📋 Queued: ${str(r, "change") ?? str(r, "title") ?? "new issue"}${newLabels}`;
      }
      return `✅ Task created: ${str(r, "title") ?? "(untitled)"}`;

    case "task.complete":
      if (field(r, "applied") === true) return `✅ ${str(r, "change") ?? "closed"}`;
      if (field(r, "staged") === true) return `📋 Queued: ${str(r, "change") ?? "close"}`;
      return `✅ Completed: ${str(r, "title") ?? "task"}`;

    case "task.update":
      if (field(r, "applied") === true) return `✅ ${str(r, "change") ?? "updated"}`;
      if (field(r, "staged") === true) return `📋 Queued: ${str(r, "change") ?? "update"}`;
      return "✏️ Task updated.";

    case "task.block":
      if (field(r, "applied") === true) return `🚧 ${str(r, "change") ?? "blocked"}`;
      if (field(r, "staged") === true) return `📋 Queued: ${str(r, "change") ?? "block"}`;
      return "🚧 Marked blocked.";

    case "task.unblock":
      if (field(r, "applied") === true) return `▶️ ${str(r, "change") ?? "unblocked"}`;
      if (field(r, "staged") === true) return `📋 Queued: ${str(r, "change") ?? "unblock"}`;
      return "▶️ Unblocked — status is now RESUMED.";

    case "task.list": {
      // Linear returns { total, tasks, truncated }; the local table a bare array.
      const rows = Array.isArray(r) ? r : (field(r, "tasks") as unknown[] | undefined) ?? [];
      const total = Array.isArray(r) ? rows.length : Number(field(r, "total") ?? rows.length);
      const truncated = field(r, "truncated") === true;
      if (rows.length === 0) return "No tasks match.";
      const line = (t: unknown) => {
        const due = str(t, "dueAt");
        // A Linear-backed row carries its identifier and the team's own
        // word for the column; a local one has neither.
        const id = str(t, "taskId");
        const identifier = id && /^[A-Z][A-Z0-9]*-\d+$/.test(id) ? `${id} ` : "";
        const state = str(t, "stateName") ?? str(t, "status") ?? "?";
        return `• ${identifier}${str(t, "title") ?? "(untitled)"} — ${state}${due ? `, due ${due}` : ""}`;
      };
      const header = Array.isArray(r)
        ? []
        : [`${truncated ? "At least " : ""}${total} task${total === 1 ? "" : "s"}${
            rows.length < total ? ` (showing ${rows.length})` : ""
          }:`];
      // Grouped by project when any row has one, so "my tasks" reads the way
      // the board does: each project, then the ones in no project.
      const hasProjects = rows.some((t) => str(t, "project"));
      if (!hasProjects) return [...header, ...rows.map(line)].join("\n");
      const groups = new Map<string, unknown[]>();
      for (const t of rows) {
        const key = str(t, "project") ?? "No project";
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      const out = [...header];
      for (const [name, items] of groups) out.push("", `${name}:`, ...items.map(line));
      return out.join("\n").trim();
    }

    case "task.bulk_update": {
      const toChange = Number(field(r, "toChange") ?? 0);
      const matched = Number(field(r, "matched") ?? 0);
      if (toChange === 0) {
        return matched === 0 ? "No tasks matched, so nothing changes." : `All ${matched} matching tasks are already there.`;
      }
      const changes = field(r, "changes");
      const list = Array.isArray(changes) ? changes.map((c) => `  • ${String(c)}`) : [];
      return [
        `📋 ${toChange} task${toChange === 1 ? "" : "s"} ready to move${field(r, "truncated") === true ? " (more exist beyond the first 250)" : ""}:`,
        ...list,
        "",
        `Nothing has changed yet. Tap Apply on the card to do it. Expires ${str(r, "approvalExpiresAt") ?? "soon"}.`,
      ].join("\n");
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

    case "calendar.list_events": {
      const rows = field(r, "events");
      const events = Array.isArray(rows) ? rows : [];
      const when = windowWords(str(r, "window"));
      const unread = couldNotRead(r);
      if (events.length === 0) return `Nothing on your calendar ${when}.${unread}`;

      const lines = events.map((e) => {
        const guests = field(e, "guests");
        const guestCount = Array.isArray(guests) ? guests.length : 0;
        const place = str(e, "location");
        return [
          `**${field(e, "allDay") === true ? "All day" : (str(e, "startsAt") ?? "?")}** — ${
            str(e, "title") ?? "(no title)"
          }`,
          str(e, "endsAt") && field(e, "allDay") !== true ? `until ${str(e, "endsAt")}` : "",
          place ? `📍 ${place}` : "",
          guestCount > 0
            ? `👥 ${guestCount === 1 ? (guests as string[])[0] : `${guestCount} guests`}`
            : "",
          str(e, "calendarOf") ? `🗓 ${str(e, "calendarOf")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });

      return [`**Your calendar — ${when}**`, ...lines].join("\n\n") + unread;
    }

    case "calendar.get_event": {
      if (field(r, "found") !== true) return "No event matching that.";
      const guests = field(r, "guests");
      const list = Array.isArray(guests) ? (guests as string[]) : [];
      const place = str(r, "location");
      const description = str(r, "description");
      return [
        `**${str(r, "title") ?? "(no title)"}**`,
        field(r, "allDay") === true
          ? "All day"
          : `${str(r, "startsAt") ?? "?"} → ${str(r, "endsAt") ?? "?"}`,
        place ? `📍 ${place}` : "",
        list.length ? `👥 ${list.join(", ")}` : "",
        description ? `\n${description.slice(0, 800)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "calendar.find_free_slots": {
      const rows = field(r, "slots");
      const slots = Array.isArray(rows) ? rows : [];
      const when = windowWords(str(r, "window"));
      const mins = field(r, "durationMinutes");
      if (slots.length === 0) {
        return `No ${typeof mins === "number" ? `${mins}-minute ` : ""}gap ${when}.`;
      }
      return [
        `**Free ${typeof mins === "number" ? `for ${mins} min ` : ""}${when}**`,
        ...slots.map((sl) => `• ${str(sl, "startsAt") ?? "?"} → ${str(sl, "endsAt") ?? "?"}`),
      ].join("\n");
    }

    case "calendar.check_availability": {
      const show = (e: unknown) =>
        `${str(e, "title") ?? "(no title)"} — ${field(e, "allDay") === true ? "all day" : `${str(e, "startsAt") ?? "?"} → ${str(e, "endsAt") ?? "?"}`}${
          str(e, "calendarOf") ? ` (${str(e, "calendarOf")})` : ""
        }`;
      const list = (key: string) => {
        const rows = field(r, key);
        return Array.isArray(rows) ? rows : [];
      };
      const conflicts = list("conflicts");
      const nearby = list("nearby");
      return [
        `Asked about: ${str(r, "askedAbout") ?? "?"}`,
        field(r, "free") === true ? "FREE — nothing booked then." : "BUSY — clashes with:",
        ...conflicts.map((e) => `- ${show(e)}`),
        nearby.length ? "Within an hour either side:" : "Nothing else within an hour either side.",
        ...nearby.map((e) => `- ${show(e)}`),
      ].join("\n") + couldNotRead(r);
    }

    case "calendar.create_event": {
      // An event with guests is HELD, not created. Saying "added" here would
      // be a lie until the card is tapped — and a confident lie about
      // somebody else's calendar is the worst kind in this system.
      if (field(r, "awaitingApproval") === true) {
        const guests = field(r, "attendees");
        const list = Array.isArray(guests) ? (guests as string[]) : [];
        return [
          `📅 **Not sent yet** — ${str(r, "title") ?? "event"} at ${str(r, "startsAt") ?? "?"}`,
          `Invites would go to ${list.join(", ")}.`,
          `Tap **Send invite** on the card to confirm.`,
        ].join("\n");
      }
      return [
        `📅 Added: **${str(r, "title") ?? "event"}**`,
        `${str(r, "startsAt") ?? "?"} → ${str(r, "endsAt") ?? "?"}`,
      ].join("\n");
    }

    case "calendar.apply_event": {
      if (field(r, "awaitingApproval") === true) {
        const expires = str(r, "expiresAt");
        return expires
          ? `⏳ Tap Send invite on the card to confirm — expires ${expires}.`
          : "⏳ Tap Send invite on the card to confirm.";
      }
      const guests = field(r, "attendees");
      const list = Array.isArray(guests) ? (guests as string[]) : [];
      return [
        `📅 Invitation sent: **${str(r, "title") ?? "event"}**`,
        `${str(r, "startsAt") ?? "?"}`,
        list.length ? `Invited: ${list.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "drive.search_files": {
      const rows = field(r, "files");
      const files = Array.isArray(rows) ? rows : [];
      const looked = str(r, "name") ?? str(r, "text") ?? str(r, "kind") ?? "that";
      if (files.length === 0) return `Nothing in your Drive matching "${looked}".`;

      // Numbered and dated, because this is a CHOOSING list. The whole
      // Drive design is "the model narrows, you choose" — a list you cannot
      // tell apart is not a choice.
      const entries = files.map((f, i) =>
        [
          `**${i + 1}. ${str(f, "title") ?? "(untitled)"}**`,
          [str(f, "kind"), str(f, "modifiedAt") ? `edited ${str(f, "modifiedAt")}` : ""]
            .filter(Boolean)
            .join(" · "),
          str(f, "link") ?? "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return [
        `**${files.length} file${files.length === 1 ? "" : "s"} matching "${looked}"**`,
        ...entries,
      ].join("\n\n");
    }

    case "drive.get_metadata": {
      if (field(r, "found") !== true) return "No file matching that.";
      return [
        `**${str(r, "title") ?? "(untitled)"}**`,
        [str(r, "kind"), str(r, "modifiedAt") ? `edited ${str(r, "modifiedAt")}` : ""]
          .filter(Boolean)
          .join(" · "),
        str(r, "owner") ? `Owner: ${str(r, "owner")}` : "",
        str(r, "link") ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "drive.read_content": {
      if (field(r, "found") !== true) return "No file matching that.";
      if (field(r, "readable") !== true) {
        return `I found **${str(r, "title") ?? "that file"}**, but I can't read it — ${
          str(r, "reason") ?? "unsupported file type"
        }.`;
      }
      const content = str(r, "content") ?? "";
      return [
        `**${str(r, "title") ?? "(untitled)"}**`,
        [str(r, "kind"), str(r, "modifiedAt") ? `edited ${str(r, "modifiedAt")}` : ""]
          .filter(Boolean)
          .join(" · "),
        "",
        content.slice(0, DRIVE_RENDER_CAP) || "(empty)",
        content.length > DRIVE_RENDER_CAP
          ? `\n[…${content.length - DRIVE_RENDER_CAP} more characters]`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "email.archive":
    case "email.mark_read":
    case "email.mark_unread":
    case "email.label": {
      const what = `**${str(r, "subject") ?? "(no subject)"}** from ${str(r, "from") ?? "?"}`;
      const box = str(r, "accountLabel");
      const where = box ? ` · ${box}` : "";

      switch (outcome.name) {
        case "email.archive":
          return `📥 Archived ${what}${where}\nStill in All Mail — nothing was deleted.`;
        case "email.mark_read":
          return `✅ Marked read: ${what}${where}`;
        case "email.mark_unread":
          return `📩 Marked unread: ${what}${where}`;
        default: {
          const label = str(r, "label") ?? "label";
          const verb = field(r, "removed") === true ? "Removed" : "Added";
          const made = field(r, "createdLabel") === true ? `\n🏷️ Created the "${label}" label.` : "";
          return `🏷️ ${verb} **${label}** ${
            field(r, "removed") === true ? "from" : "on"
          } ${what}${where}${made}`;
        }
      }
    }

    case "email.list_recent":
    case "email.search":
      return renderEmailList(r, timezone);

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

    case "linear.list_issues": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "No matching Linear issues.";
      return rows.map(renderLinearIssueRow).join("\n");
    }

    case "linear.get_issue": {
      if (field(r, "found") !== true) return "No Linear issue matching that id.";
      const description = str(r, "description");
      return [
        `${str(r, "identifier") ?? "?"} — ${str(r, "title") ?? "(untitled)"}`,
        `State: ${str(field(r, "state"), "name") ?? "?"}   Priority: ${linearPriorityWord(field(r, "priority"))}`,
        String(field(r, "url") ?? ""),
        "",
        description || "(no description)",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "linear.propose_changeset": {
      const rows = field(r, "changes");
      const changes = Array.isArray(rows) ? rows : [];
      return [
        `📋 ${str(r, "summary") ?? "Proposed batch"} (${changes.length} issue${changes.length === 1 ? "" : "s"})`,
        ...changes.map((c, n) => {
          const change = c as Record<string, unknown>;
          const parts: string[] = [];
          if (typeof change.stateName === "string") parts.push(`state → ${change.stateName}`);
          if (typeof change.title === "string") parts.push(`title → "${change.title}"`);
          if (typeof change.priority === "number") {
            parts.push(`priority → ${LINEAR_PRIORITY_WORDS[change.priority] ?? change.priority}`);
          }
          if (typeof change.description === "string") parts.push("description updated");
          return `  ${n + 1}. ${String(change.issueId ?? change.issueRef ?? "?")} — ${parts.join(", ") || "no change"}`;
        }),
        "",
        // Deliberately NOT "say approved" and deliberately NOT quoting the
        // changeset id. The card above carries the button; giving the model
        // an id to repeat invites it to call apply itself with a stale one
        // from earlier in the conversation, which is exactly what happened.
        `Tap Apply on the card above to write these to Linear. Expires ${str(r, "approvalExpiresAt") ?? "soon"}.`,
      ].join("\n");
    }

    case "linear.apply_changeset": {
      // Same shape as email.send_reply: a call that reaches the gate without
      // a consumed approval is not an error, it is the system waiting for a
      // tap. Rendering it as "unknown error" made a working refusal look
      // broken.
      if (field(r, "awaitingApproval") === true) {
        const expires = str(r, "expiresAt");
        return expires
          ? `⏳ Tap Apply on the card to confirm — expires ${expires}.`
          : "⏳ Tap Apply on the card to confirm.";
      }
      if (field(r, "error") !== undefined) {
        return `⚠️ Not applied: ${str(r, "error")}`;
      }

      // A batch can hold new issues as well as edits, so both halves report.
      const madeRows = field(r, "created");
      const made = Array.isArray(madeRows) ? madeRows : [];
      const rows = field(r, "results");
      const results = Array.isArray(rows) ? rows : [];

      const createdLines = made.map((x) =>
        field(x, "success") === true
          ? `  ✅ ${str(x, "identifier") ?? "?"} — ${str(x, "title") ?? ""}`.trimEnd()
          : `  ⚠️ "${str(x, "title") ?? "?"}" — ${str(x, "error") ?? "failed"}`,
      );
      const updatedLines = results.map((x) =>
        field(x, "success") === true
          ? `  ✅ ${str(x, "identifier") ?? str(x, "issueId")}`
          : `  ⚠️ ${str(x, "issueId") ?? "?"} — ${str(x, "error") ?? "failed"}`,
      );

      const total = made.length + results.length;
      const okCount =
        made.filter((x) => field(x, "success") === true).length +
        results.filter((x) => field(x, "success") === true).length;

      const verification = field(r, "verification");
      const checked = Number(field(verification, "checked") ?? 0);
      const mismatchedRows = field(verification, "mismatched");
      const mismatched = Array.isArray(mismatchedRows) ? mismatchedRows : [];
      const verifiedLine =
        checked === 0
          ? []
          : mismatched.length === 0
            ? [`Checked on the board: all ${checked} are where you asked.`]
            : [
                `⚠️ Checked on the board: ${mismatched.length} of ${checked} did NOT move:`,
                ...mismatched.map((m) => `  • ${str(m, "identifier") ?? "?"} is still ${str(m, "state") ?? "?"}`),
              ];

      return [
        `Applied ${okCount}/${total} change${total === 1 ? "" : "s"} in Linear:`,
        ...(createdLines.length ? ["  Created:", ...createdLines] : []),
        ...(updatedLines.length && createdLines.length ? ["  Updated:"] : []),
        ...updatedLines,
        ...verifiedLine,
      ].join("\n");
    }

    case "note.save": {
      const category = str(r, "category");
      return category
        ? `📓 Saved to Notion under **${category}**: ${str(r, "title") ?? "note"}`
        : `📓 Saved to Notion: **${str(r, "title") ?? "note"}**`;
    }

    case "note.categories": {
      if (field(r, "reachable") === false) return `⚠️ ${str(r, "reason")}`;
      const rows = field(r, "categories");
      const categories = Array.isArray(rows) ? rows : [];
      if (categories.length === 0) {
        return "No sections yet — saving a note with a category creates one.";
      }
      return [
        `📓 ${categories.length} section${categories.length === 1 ? "" : "s"}:`,
        ...categories.map((c) => `  • ${String((c as Record<string, unknown>).name ?? "?")}`),
      ].join("\n");
    }

    case "note.search": {
      // "Could not reach" and "found nothing" are DIFFERENT sentences, and
      // with no local copy of the notes the difference is the whole point.
      if (field(r, "reachable") === false) return `⚠️ ${str(r, "reason")}`;

      const rows = field(r, "notes");
      const notes = Array.isArray(rows) ? rows : [];
      if (notes.length === 0) {
        return "Nothing in your Notion notes matched that title. Notion only searches titles, so try a different word.";
      }
      return [
        `📓 ${notes.length} note${notes.length === 1 ? "" : "s"}:`,
        ...notes.map((entry) => {
          const n = entry as Record<string, unknown>;
          const section = typeof n.category === "string" && n.category ? ` (${n.category})` : "";
          return `  • ${String(n.title ?? "(untitled)")}${section}  [${String(n.pageId ?? "")}]`;
        }),
      ].join("\n");
    }

    case "note.get": {
      if (field(r, "reachable") === false) return `⚠️ ${str(r, "reason")}`;
      if (field(r, "notFound") === true) {
        return `No note matching "${str(r, "query") ?? "that"}". Titles only — try a different word, or ask what sections you have.`;
      }
      return [`📓 **${str(r, "title") ?? "Note"}**`, "", str(r, "markdown") ?? "(empty)"].join("\n");
    }

    case "capture.propose": {
      const rows = field(r, "items");
      const items = Array.isArray(rows) ? rows : [];
      const dupes = field(r, "duplicates");
      const overflow = field(r, "overflow");

      // The card carries the full list and the buttons. This line exists so
      // the chat transcript says what is waiting, without duplicating it.
      return [
        `📥 Found **${items.length}** ${items.length === 1 ? "item" : "items"}: ${
          str(r, "title") ?? "a list"
        }`,
        typeof dupes === "number" && dupes > 0
          ? `Skipped ${dupes} duplicate${dupes === 1 ? "" : "s"}.`
          : "",
        typeof overflow === "number" && overflow > 0
          ? `⚠️ ${overflow} more were left out — the cap is 30.`
          : "",
        `Tap **Add all ${items.length}** on the card to save them.`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "capture.apply": {
      if (field(r, "awaitingApproval") === true) {
        const expires = str(r, "expiresAt");
        return expires
          ? `⏳ Tap Add on the card to confirm — expires ${expires}.`
          : "⏳ Tap Add on the card to confirm.";
      }
      const count = field(r, "count");
      const n = typeof count === "number" ? count : 0;

      if (str(r, "destination") === "notes") {
        return [
          `✅ Saved **${n}** ${n === 1 ? "item" : "items"} to ${
            str(r, "category") ?? "your notes"
          }: ${str(r, "title") ?? ""}`.trimEnd(),
          str(r, "url") ?? "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (str(r, "destination") === "list") {
        const attempted = field(r, "attempted");
        const failed = field(r, "failed");
        const lines = [
          `✅ Added **${n}**${typeof attempted === "number" && attempted !== n ? ` of ${attempted}` : ""} to your ${
            str(r, "category") ?? ""
          } list in Notion.`,
        ];
        if (Array.isArray(failed) && failed.length > 0) {
          lines.push(`⚠️ Not added: ${failed.map(String).join("; ")}`);
        }
        return lines.join("\n");
      }

      const attempted = field(r, "attempted");
      const total = typeof attempted === "number" ? attempted : n;
      // On the Linear backend these are STAGED, not written — saying "added"
      // before the second tap would be a lie about a shared tracker.
      if (field(r, "staged") === true) {
        return `📋 Queued **${n}** task${n === 1 ? "" : "s"} — tap Apply on the card to write them to Linear.`;
      }
      return `✅ Created **${n}**${total !== n ? ` of ${total}` : ""} task${n === 1 ? "" : "s"}.`;
    }

    case "link.read": {
      const lines: string[] = [];
      const author = str(r, "authorName");
      const title = str(r, "title");
      lines.push(`🔗 **${title ?? str(r, "platform") ?? "post"}**${author ? ` — ${author}` : ""}`);
      const summary = str(r, "summary");
      if (summary) lines.push(summary);
      const entities = field(r, "entities");
      if (Array.isArray(entities) && entities.length > 0) {
        lines.push(
          "",
          `**In it (${entities.length})**`,
          ...entities.map((e, n) => {
            const name = str(e, "name") ?? "?";
            const detail = str(e, "detail");
            const status = str(e, "status");
            return `${n + 1}. ${name}${detail ? ` — ${detail}` : ""}${status === "in_list" ? " ✓ on a list" : ""}`;
          }),
        );
      }

      const caption = str(r, "caption");
      if (caption) lines.push("", "**Caption**", caption);

      const imageText = str(r, "imageText");
      if (imageText) lines.push("", "**Text in the image**", imageText);

      if (!caption && !imageText) {
        lines.push(
          "",
          "That post gave up nothing readable — it may be private, deleted, " +
            "or login-only. Screenshot it and send the picture; I'll read that.",
        );
      } else if (!caption) {
        // Common on Instagram: og:image with no og:description at all. Say so,
        // rather than letting the absence read as "the post had no words".
        lines.push("", "_No caption was published with this post — the above is read off the image._");
      }

      // Say plainly what could NOT be reached. Returning slide 1 as though it
      // were the whole post is the failure worth designing against, and the
      // fix the user can actually apply is screenshots.
      // How much of the post was actually read. A ten-slide deck where four
      // were reachable is a different answer from one where ten were, and the
      // difference has to be visible before anything is built on it.
      const read = field(r, "imagesRead");
      if (typeof read === "number" && read > 1) {
        lines.push("", `_Read ${read} slides._`);
      }
      if (str(r, "videoTranscript")) lines.push("", "_Watched the video too._");

      const note = str(r, "note");
      if (field(r, "slidesUnavailable") === true) {
        lines.push(
          "",
          `⚠️ Not all of this post could be read${note ? ` (${note})` : ""}. If the ` +
            "slides are what you want, screenshot them and send them — I'll read them.",
        );
      } else if (note) {
        lines.push("", `_${note}_`);
      }
      if (caption || imageText) {
        lines.push("", field(r, "fresh") === false ? "📌 Already saved — I'll remember this." : "📌 Saved. Ask me about it any time.");
      }

      return lines.join("\n");
    }

    case "saved.search": {
      const items = field(r, "items");
      if (!Array.isArray(items) || items.length === 0) {
        return `🔎 Nothing in your saved posts matches "${str(r, "query") ?? ""}".`;
      }
      return [
        `🔎 ${items.length} saved post${items.length === 1 ? "" : "s"} for "${str(r, "query") ?? ""}":`,
        ...items.map((item) => renderSavedItem(item as SavedItemView, false)),
      ].join("\n\n");
    }

    case "saved.get":
      return renderSavedItem(r as SavedItemView, true);

    case "saved.recent": {
      const items = field(r, "items");
      if (!Array.isArray(items) || items.length === 0) return "📌 You haven't saved any posts yet.";
      return [
        "📌 Recently saved:",
        ...items.map(
          (i, n) =>
            `${n + 1}. ${str(i, "title") ?? "(untitled)"}${str(i, "author") ? ` — ${str(i, "author")}` : ""} ` +
            `(${str(i, "savedAt") ?? ""}) [${str(i, "itemId") ?? ""}]`,
        ),
      ].join("\n");
    }

    case "saved.forget":
      return `🗑️ I'll stop bringing up "${str(r, "title") ?? "that post"}".`;

    case "list.query": {
      const items = field(r, "items");
      const list = str(r, "list") ?? "list";
      if (!Array.isArray(items) || items.length === 0) {
        return field(r, "source") === "notion"
          ? `Your ${list} list has nothing left on it.`
          : `There's no "${list}" list in Notion, and no saved posts mention any.`;
      }
      const head =
        field(r, "source") === "notion"
          ? `📋 ${list} — ${String(field(r, "unfinished") ?? items.length)} not done yet:`
          : `📋 No Notion list called "${list}"; from your saved posts:`;
      return [
        head,
        ...items.map(
          (i, n) =>
            `${n + 1}. ${str(i, "name") ?? "?"}${str(i, "detail") ? ` — ${str(i, "detail")}` : ""}` +
            `${str(i, "status") ? ` [${str(i, "status")}]` : ""}`,
        ),
      ].join("\n");
    }

    case "list.mark_done":
      return `✅ Marked **${str(r, "name") ?? "it"}** as ${str(r, "status") ?? "done"} on your ${str(r, "list") ?? ""} list.`;

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
      // Same header vocabulary as a list row, so one email and a list of
      // them read as the same product rather than two different tools.
      const icon = IMPORTANCE_ICON[str(r, "importance") ?? ""] ?? "";
      const receivedAt = field(r, "receivedAtMs");
      const when =
        typeof receivedAt === "number" ? formatDayTime(receivedAt, timezone) : str(r, "receivedAt");
      const box = str(r, "accountLabel");
      return [
        `${icon ? `${icon} ` : ""}**${str(r, "from") ?? "?"}**${
          field(r, "spam") === true ? " ⚠️ SPAM" : ""
        }`,
        `**${str(r, "subject") ?? "(no subject)"}**`,
        `${when ?? ""}${box ? ` · ${box}` : ""}`,
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

    case "persona.set": {
      if (field(r, "found") === false) {
        const available = Array.isArray(field(r, "available")) ? (field(r, "available") as string[]) : [];
        return `I don't have a "${str(r, "asked") ?? "?"}" personality. I can be: ${available.join(", ")}.`;
      }
      const times = Array.isArray(field(r, "times")) ? (field(r, "times") as string[]) : [];
      const checkins =
        field(r, "checkinsOn") === true
          ? `I'll check in at ${joinTimes(times)}.`
          : "Unprompted check-ins are off.";
      if (field(r, "changed") === true) {
        return `${str(r, "emoji") ?? ""} ${str(r, "name") ?? ""} mode on. ${checkins}`.trim();
      }
      return str(r, "listing") ?? `${str(r, "emoji") ?? ""} ${str(r, "name") ?? ""}. ${checkins}`.trim();
    }

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

/** "12:30 and 17:30", "13:00, 18:00 and 21:30". */
function joinTimes(times: string[]): string {
  if (times.length <= 1) return times.join("");
  return `${times.slice(0, -1).join(", ")} and ${times.at(-1)}`;
}
