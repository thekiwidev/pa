// Pure. Short, turn-local handles for things the assistant has seen — so the
// model can say "E2" instead of quoting (or inventing) a database id.
//
// WHY THIS EXISTS
//
// Ids are deliberately never shown in chat (MEMORY.md, 2026-08-24), which
// left the model one way to point at an email: re-describe it with
// senderOrSubject and hope the fragment match lands on the same message. A
// search for "Polaris" with five Polaris mails picks whichever is newest.
//
// So every email the model is shown gets a label — E0 for the one the
// conversation is about, E1..En for anything a tool returned this turn. The
// model may put a label in `emailMessageId`; substituteRefs swaps in the real
// id before the router sees the call. The router still validates the id, so
// a made-up label resolves to nothing rather than to the wrong message.

import { formatDayTime } from "../time";
import type { ToolCall } from "../tools/plan";

export interface ToolOutcomeLike {
  name: string;
  ok: boolean;
  result: unknown;
}

export interface EmailRefItem {
  ref: string;
  kind: "email";
  /** The Convex emailMessages id. Never rendered into a prompt. */
  id: string;
  from: string;
  subject: string;
  receivedAtMs?: number;
  accountLabel?: string;
  importance?: string;
  spam: boolean;
  snippet?: string;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

const str = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

function toItem(row: unknown, ref: string): EmailRefItem | null {
  const id = str(row, "emailMessageId");
  if (!id) return null;
  const received = field(row, "receivedAtMs");
  return {
    ref,
    kind: "email",
    id,
    from: str(row, "from") ?? "?",
    subject: str(row, "subject") ?? "(no subject)",
    receivedAtMs: typeof received === "number" ? received : undefined,
    accountLabel: str(row, "accountLabel"),
    importance: str(row, "importance"),
    spam: field(row, "spam") === true,
    snippet: str(row, "snippet"),
  };
}

/**
 * Every email a tool returned this turn, labelled E{start}, E{start+1}, …
 * in the order the tools ran. Duplicates (the same message from two tools)
 * keep their first label.
 */
export function collectEmailRefs(outcomes: ToolOutcomeLike[], start = 1): EmailRefItem[] {
  const items: EmailRefItem[] = [];
  const seen = new Set<string>();
  let next = start;

  const add = (row: unknown) => {
    const id = str(row, "emailMessageId");
    if (!id || seen.has(id)) return;
    const item = toItem(row, `E${next}`);
    if (!item) return;
    seen.add(id);
    items.push(item);
    next += 1;
  };

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const rows = field(outcome.result, "messages");
    if (Array.isArray(rows)) rows.forEach(add);
    else if (str(outcome.result, "emailMessageId")) add(outcome.result);
  }
  return items;
}

/** One line per email: everything needed to answer "who / what / when / where". */
export function renderEmailRef(item: EmailRefItem, timezone: string): string {
  const when =
    item.receivedAtMs === undefined ? "time unknown" : formatDayTime(item.receivedAtMs, timezone);
  const parts = [
    `${item.ref}`,
    `from ${item.from}`,
    `subject "${item.subject}"`,
    `received ${when}`,
    item.accountLabel ? `mailbox ${item.accountLabel}` : "",
    item.importance ? `importance ${item.importance}` : "",
    item.spam ? "IN SPAM" : "",
  ].filter(Boolean);
  const snippet = item.snippet?.trim();
  return parts.join(" · ") + (snippet ? `\n    preview: ${snippet.slice(0, 200)}` : "");
}

export function renderEmailRefs(items: EmailRefItem[], timezone: string): string {
  return items.map((i) => renderEmailRef(i, timezone)).join("\n");
}

const REF_PATTERN = /^\s*(E\d+|focus)\s*$/i;

/**
 * Swap any E-label the model used for the real id. Anything that is not a
 * known label is left alone for the router to validate — including labels
 * the model invented, which then match no message and fail visibly.
 */
export function substituteRefs(calls: ToolCall[], refs: Map<string, string>): ToolCall[] {
  return calls.map((call) => {
    const raw = call.args.emailMessageId;
    if (typeof raw !== "string") return call;
    const match = REF_PATTERN.exec(raw);
    if (!match) return call;
    const token = (match[1] ?? "").toUpperCase();
    const key = token === "FOCUS" ? "E0" : token;
    const id = refs.get(key);
    if (!id) return call;
    return { ...call, args: { ...call.args, emailMessageId: id } };
  });
}

/** Which item the model said its reply is about, if any. */
export function resolveFocus(
  focus: string | undefined,
  items: EmailRefItem[],
): EmailRefItem | undefined {
  if (!focus) return undefined;
  const key = focus.trim().toUpperCase();
  return items.find((i) => i.ref === key);
}
