// Pure-ish: no ctx, no fetch — but real crypto, so it shares the Web Crypto
// runtime convex/security/crypto.ts already uses for AES-GCM. SHA-256 needs
// no secret key and no npm dependency; crypto.subtle.digest is available in
// the same V8 runtime this project runs everything else in.
//
// This hash IS invariant I-4's enforcement, not a debugging aid. An approval
// is bound to it at creation time. approvals.consume recomputes it from the
// LIVE draft — never from a copy stored on the approval row — so an edit
// made after approval and before the [Send] tap silently voids the approval
// instead of silently sending the edited text.

export interface DraftPayload {
  accountId: string;
  /**
   * Anchors the hash to a specific source message — the role the source
   * plan's formula gives `thread_id`. This schema's `drafts` table stores
   * `emailMessageId`, not a separate thread id column, and a message id is
   * at least as specific a target.
   */
  anchorId: string;
  inReplyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** Phase 11 (Drive attachments). Included from Phase 6 on so a later
   *  attachment swap has no special-cased hash path to remember to add. */
  attachmentFileIds?: string[];
}

// ASCII unit separator — won't appear in an address, a subject, or prose.
const SEPARATOR = "\u001f";

function canonicalize(payload: DraftPayload): string {
  return [
    payload.accountId,
    payload.anchorId,
    payload.inReplyTo ?? "",
    payload.to.join(","),
    payload.cc.join(","),
    payload.subject,
    payload.body,
    (payload.attachmentFileIds ?? []).join(","),
  ].join(SEPARATOR);
}

export async function payloadHash(payload: DraftPayload): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One proposed Linear write, in the shape the hash cares about.
 *
 * `op` distinguishes an update from a create. A create has no issueId — it
 * has a teamId and the fields the new issue will be born with — so every one
 * of those must be in the canonical string too. A field that changes what
 * gets written and is NOT hashed is a field the user can be shown one value
 * for and have another applied.
 */
export interface ChangesetEntry {
  /** Absent means "update", so entries written before creates existed still
   *  hash to the same string they always did. */
  op?: "create" | "update";
  /** Required for an update; absent on a create. */
  issueId?: string;
  /** Required for a create; absent on an update. */
  teamId?: string;
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  labelIds?: string[];
  dueDate?: string;
}

/**
 * The same discipline payloadHash applies to a draft, applied to a Linear
 * batch: every field that changes what gets written, in a fixed order, so an
 * edited batch can never match a stale approval.
 *
 * Lives here rather than in tools/router.ts because model/approvals.ts has to
 * recompute it at consume time, and model/ must not import from tools/.
 */
export async function changesetPayloadHash(changes: ChangesetEntry[]): Promise<string> {
  const canonical = changes
    .map((c) =>
      [
        c.op ?? "update",
        c.issueId ?? "",
        c.teamId ?? "",
        c.title ?? "",
        c.description ?? "",
        c.stateId ?? "",
        c.priority ?? "",
        (c.labelIds ?? []).join(","),
        c.dueDate ?? "",
      ].join("\u001f"),
    )
    .join("\u001e");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A changeset's addressable id: the first 16 hex characters of its hash.
 *
 * Short because it rides in Telegram's callback_data, which is capped at 64
 * BYTES total including the prefix — a full 64-char SHA-256 hex does not fit.
 * Still content-addressed, and 64 bits is far beyond collision range for one
 * user's pending batches. The FULL hash is what the approval binds itself to,
 * so shortening the id weakens addressing, never integrity.
 */
export function changesetIdFromHash(hash: string): string {
  return hash.slice(0, 16);
}


/**
 * A calendar event awaiting approval, in the shape the hash cares about.
 *
 * Every field that changes what lands on someone else's calendar, or WHOSE
 * calendar it lands on, is here. `attendees` especially: the difference
 * between a solo focus block and a meeting invitation to a client is one
 * array, and an approval that did not bind it could be shown to you as the
 * former and applied as the latter.
 */
export interface CalendarEventEntry {
  calendarId: string;
  summary: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

export async function calendarEventPayloadHash(event: CalendarEventEntry): Promise<string> {
  const canonical = [
    event.calendarId,
    event.summary,
    event.startIso,
    event.endIso,
    event.timeZone,
    event.description ?? "",
    event.location ?? "",
    // Sorted: the same guest list in a different order is the same invitation,
    // and re-proposing it should not produce a different approval.
    [...(event.attendees ?? [])].map((a) => a.trim().toLowerCase()).sort().join(","),
  ].join(SEPARATOR);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(new Uint8Array(digest));
}


/**
 * A batch of captured items awaiting confirmation.
 *
 * Bound the same way a draft and a Linear changeset are: every field that
 * changes what gets written, in a fixed order. The ITEMS are hashed
 * individually rather than as a count, because "5 movies" matching is not
 * the same claim as "these 5 movies" matching — a re-extraction that found a
 * different fifth film must not satisfy an approval the user gave for the
 * first one.
 */
export interface CaptureBatchEntry {
  destination: string;
  category?: string;
  title: string;
  items: { title: string; detail?: string }[];
  sourceUrl?: string;
}

export async function captureBatchPayloadHash(batch: CaptureBatchEntry): Promise<string> {
  const canonical = [
    batch.destination,
    batch.category ?? "",
    batch.title,
    batch.sourceUrl ?? "",
    // Order is part of the payload: the user saw a numbered list.
    batch.items.map((i) => `${i.title}\u001d${i.detail ?? ""}`).join("\u001e"),
  ].join(SEPARATOR);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(new Uint8Array(digest));
}
