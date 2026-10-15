// Pure. A deterministic check that the reply does not claim a write that
// never happened.
//
// Measured 2026-10-15: asked to "move everything to done", the planner
// answered "Done — I moved all your current Linear backlog issues to Done"
// with no tool call at all. The prompt already said "never claim something
// happened that a tool result does not show". A prompt is the seatbelt; this
// is the crash structure, same reasoning as guardReply in lib/scope.ts.

export interface OutcomeLike {
  name: string;
  ok: boolean;
  result: unknown;
}

/**
 * Tools that only read. Anything not matched here is treated as a write, so
 * a new tool defaults to "can back a claim" only if it actually succeeded.
 */
const READ_ONLY =
  /^(?:[a-z_]+\.(?:list|list_recent|list_events|list_rules|list_issues|get|get_event|get_message|get_issue|get_project|get_metadata|search|search_files|read_content|categories|find_free_slots|check_availability|preview|summarize_thread)|link\.read|saved\.(?:search|get)|list\.query|ops\.health)$/;

export function isWriteTool(name: string): boolean {
  return !READ_ONLY.test(name);
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** A write that only opened a card or staged a batch has not happened yet. */
function isPending(result: unknown): boolean {
  return (
    field(result, "awaitingApproval") === true ||
    field(result, "staged") === true ||
    typeof field(result, "changesetId") === "string"
  );
}

const DONE_VERBS =
  "(?:moved|marked|updated|closed|completed|created|added|deleted|removed|archived|" +
  "sent|scheduled|saved|cleared|cancel(?:l)?ed|applied|changed|set)";

const COMPLETION_CLAIM = new RegExp(
  [
    // "Done — I moved…", "✅ Done."
    `^\\s*(?:✅\\s*)?(?:all\\s+)?done\\b`,
    // "I moved / I've moved / I have marked"
    `\\bI(?:'ve| have)?\\s+(?:now\\s+|just\\s+|already\\s+)?${DONE_VERBS}\\b`,
    // "they have been moved", "has been sent"
    `\\b(?:has|have)\\s+(?:now\\s+)?been\\s+${DONE_VERBS}\\b`,
  ].join("|"),
  "i",
);

export function claimsCompletedAction(reply: string): boolean {
  return COMPLETION_CLAIM.test(reply);
}

/**
 * True when the reply claims a finished action but no write in this turn
 * actually finished. Pending cards do not count: "tap Apply" is not "done".
 */
export function unbackedClaim(reply: string, outcomes: readonly OutcomeLike[]): boolean {
  if (!claimsCompletedAction(reply)) return false;
  return !outcomes.some((o) => o.ok && isWriteTool(o.name) && !isPending(o.result));
}

/** Sent back to the planner once when it claims something no tool did. */
export const CLAIM_CORRECTION =
  "CHECK: your last reply said something was done, but no tool in this turn " +
  "did it. Either call the tool that does it now, or reply saying plainly " +
  "what has NOT been done yet and what is needed. Do not repeat the claim.";

/** Last resort when the planner has no step left to correct itself. */
export const CLAIM_FALLBACK =
  "I haven't changed anything yet — nothing ran on my side for that. " +
  "Say it once more and I'll do it properly.";
