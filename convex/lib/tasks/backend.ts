// Pure. No ctx, no fetch. Which store owns tasks, and how the two vocabularies
// line up.
//
// WHY THIS EXISTS
//
// There is one set of task.* tools and two places a task can live. Linear owns
// them when a Linear account is connected; the Convex `tasks` table owns them
// when one is not, so the project is usable with no Linear at all.
//
// The choice is made HERE, from a fact about the database, and never by the
// model. A model asked "should this go to Linear?" will answer from the shape
// of the sentence rather than from what is configured, and a task filed into
// the wrong store is a task the user never sees again.

export type TaskBackend = "linear" | "convex";

export function pickBackend(hasLinearAccount: boolean): TaskBackend {
  return hasLinearAccount ? "linear" : "convex";
}

/**
 * The internal status vocabulary — the one in the `tasks` table, in the
 * catalogue's TASK_STATUS enum, and in every prompt.
 */
export type TaskStatus =
  | "PLANNED"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "WAITING"
  | "RESUMED"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Linear's own state CATEGORIES. Every workflow state belongs to exactly one,
 * whatever the team has named the column.
 *
 * Mapping against these rather than against state names is the whole trick: a
 * team's finished column may be called "Done", "Shipped", "Live" or "🎉", and
 * a name match would work on one board and silently do nothing on the next.
 * Linear guarantees the category; it guarantees nothing about the name.
 */
export type LinearStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

const STATUS_TO_STATE_TYPE: Record<TaskStatus, LinearStateType> = {
  PLANNED: "backlog",
  // "I'm working on it now" and "I've picked it back up" are the same place
  // on a board. RESUMED exists in the internal vocabulary because unblocking
  // needs a status distinct from BLOCKED; Linear expresses that as simply
  // being started again.
  IN_PROGRESS: "started",
  RESUMED: "started",
  // Linear has no blocked category. A blocked issue is one that is started
  // and not moving — which is what "started" says — and the reason lives in
  // the issue description rather than being lost to an unmapped state.
  BLOCKED: "started",
  WAITING: "unstarted",
  COMPLETED: "completed",
  CANCELLED: "canceled",
};

export function stateTypeForStatus(status: TaskStatus): LinearStateType {
  return STATUS_TO_STATE_TYPE[status];
}

/**
 * The reverse, for displaying a Linear issue in the internal vocabulary.
 *
 * Lossy on purpose and in one direction only: several statuses collapse onto
 * "started", so coming back it is IN_PROGRESS. Nothing depends on a round
 * trip being exact, and pretending otherwise would mean storing a shadow
 * status in Convex — which is the second source of truth this whole design
 * exists to avoid.
 */
export function statusForStateType(type: string): TaskStatus {
  switch (type) {
    case "completed":
      return "COMPLETED";
    case "canceled":
      return "CANCELLED";
    case "started":
      return "IN_PROGRESS";
    case "unstarted":
      return "WAITING";
    case "triage":
    case "backlog":
    default:
      return "PLANNED";
  }
}

/**
 * Pick the workflow state a status should move an issue to.
 *
 * Prefers the state whose `type` matches. Within a type a team can have
 * several states ("In Review" and "In Progress" are both `started`), so the
 * first is taken — Linear returns them in board order, which makes the first
 * the leftmost, and moving an issue further left than asked is the safer
 * error of the two.
 *
 * Returns null when the team genuinely has no state of that category, which
 * the caller must report rather than guessing a different column.
 */
export function resolveStateForStatus<T extends { id: string; name: string; type: string }>(
  states: T[],
  status: TaskStatus,
): T | null {
  const wanted = stateTypeForStatus(status);
  return states.find((s) => s.type === wanted) ?? null;
}

/**
 * Resolve a state the USER named ("move it to In Review") against a team's
 * actual states, case- and space-insensitively.
 *
 * Tried BEFORE the status mapping, so a user who knows their own board gets
 * the column they asked for rather than the category's first state.
 */
export function resolveStateByName<T extends { id: string; name: string }>(
  states: T[],
  name: string,
): T | null {
  const needle = normalizeName(name);
  return states.find((s) => normalizeName(s.name) === needle) ?? null;
}

/** Case, spacing and separators all ignored: "in-progress" === "In Progress". */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Match label names the user said against the labels that exist.
 *
 * Returns the ids that matched and the names that did not, so the caller can
 * create the missing ones and SAY that it did. Silently creating a label is
 * how a board ends up with "pa", "PA" and "p-a" as three different tags.
 */
export function matchLabels<T extends { id: string; name: string }>(
  existing: T[],
  wanted: string[],
): { ids: string[]; missing: string[] } {
  const byName = new Map(existing.map((l) => [normalizeName(l.name), l]));
  const ids: string[] = [];
  const missing: string[] = [];

  for (const name of wanted) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const found = byName.get(normalizeName(trimmed));
    if (found) {
      if (!ids.includes(found.id)) ids.push(found.id);
    } else if (!missing.some((m) => normalizeName(m) === normalizeName(trimmed))) {
      missing.push(trimmed);
    }
  }

  return { ids, missing };
}

/**
 * Internal priority (1 = critical ... 5 = someday, ascending) to Linear's own
 * (0 = none, 1 = urgent ... 4 = low, descending).
 *
 * The two scales run in OPPOSITE directions and neither is a superset of the
 * other, which is exactly the kind of thing that silently inverts a board's
 * urgency if it is done inline at a call site. It is done once, here.
 */
export function linearPriorityForInternal(priority: number | undefined): number | undefined {
  if (priority === undefined) return undefined;
  switch (priority) {
    case 1:
      return 1; // critical -> urgent
    case 2:
      return 2; // high -> high
    case 3:
      return 3; // normal -> medium
    case 4:
      return 4; // low -> low
    case 5:
      return 0; // someday -> no priority
    default:
      return undefined;
  }
}

/** Linear wants a bare YYYY-MM-DD for dueDate, not an instant. */
export function linearDueDate(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Linear has no "blocked" state, so the reason lives in the description.
 *
 * A marker line rather than a label because a blocker is a SENTENCE — "waiting
 * on Paul's contract" — and a label can only be a word. Kept as the first line
 * so it is visible in Linear's own preview.
 */
const BLOCKER_MARKER = "🚧 **Blocked:**";

export function withBlockerNote(description: string | null | undefined, reason: string): string {
  const rest = withoutBlockerNote(description);
  const note = `${BLOCKER_MARKER} ${reason.trim()}`;
  return rest ? `${note}\n\n${rest}` : note;
}

/** Strips any existing blocker line, so unblocking is not additive. */
export function withoutBlockerNote(description: string | null | undefined): string {
  if (!description) return "";
  return description
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(BLOCKER_MARKER))
    .join("\n")
    .trim();
}

export function hasBlockerNote(description: string | null | undefined): boolean {
  return Boolean(description?.includes(BLOCKER_MARKER));
}

/** The reason out of a blocker line, for listing what is stuck. */
export function blockerReason(description: string | null | undefined): string {
  const line = (description ?? "")
    .split("\n")
    .find((l) => l.trimStart().startsWith(BLOCKER_MARKER));
  return line ? line.trimStart().slice(BLOCKER_MARKER.length).trim() : "";
}

/**
 * Does this message plausibly concern tasks?
 *
 * On the Linear backend, listing open issues into the prompt costs a GraphQL
 * round trip. Paying it on every "hi" would be a tax on every message the bot
 * ever handles, for a list that turn will not use — the same reasoning that
 * keeps skills keyword-gated and userContext capped at 40 entries
 * (invariant 7). Deterministic, no model call spent deciding.
 *
 * Deliberately generous: a false positive costs one query, a false negative
 * costs the model the ids it needed to act.
 */
const TASK_KEYWORDS = [
  "task",
  "todo",
  "to-do",
  "to do",
  "issue",
  "ticket",
  "backlog",
  "board",
  "linear",
  "project",
  "sprint",
  "blocked",
  "blocker",
  "waiting on",
  "working on",
  "in progress",
  "done",
  "finished",
  "complete",
  "priority",
  "due",
  "deadline",
  "assign",
  "what am i",
  "what's on",
  "whats on",
];

export function mentionsTasks(message: string): boolean {
  const lower = message.toLowerCase();
  return TASK_KEYWORDS.some((k) => lower.includes(k));
}
