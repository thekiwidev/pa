// Pure. No ctx, no fetch. Builds Gmail's `q` search string from typed fields.
//
// WHY THIS EXISTS
//
// The model used to hand `email.search` a single `query` string that was
// passed VERBATIM into Gmail's `q` on the live path (gmail.ts deepSearch).
// That is invariant I-1 inverted: the model was writing the query language,
// and the catalogue tried to fix it with a warning —
//
//     "a PLAIN word or phrase ... NOT Gmail search syntax;
//      'from:x@y.com subject:foo' matches nothing"
//
// — which was simply false on that path, and steered the model away from the
// one filter that worked. So it searched with no filter at all and returned
// 25 arbitrary messages when the user had asked for one specific email.
//
// Now the model proposes typed FIELDS and this file writes the query. Two
// consequences fall out for free:
//
//   1. Free text is quoted, so a query containing "from:" is searched for as
//      the literal words rather than becoming an operator. The model cannot
//      write Gmail syntax even by accident, which is what the description was
//      trying and failing to achieve.
//   2. Date windows become expressible, which is what makes widening a search
//      possible without repeating results.

export interface GmailQueryInput {
  /** Free text: matched anywhere. Quoted, never interpreted as syntax. */
  query?: string;
  /** Sender name or address. */
  from?: string;
  /** Words in the subject. */
  subject?: string;
  /** A Gmail labelId, e.g. "SPAM". */
  gmailLabel?: string;
  /** Window start — messages received at or after this instant. */
  afterMs?: number;
  /** Window end — messages received before this instant. */
  beforeMs?: number;
}

/**
 * Gmail treats a double quote as a phrase delimiter and has no escape for it,
 * so a value containing one cannot be quoted — it is stripped instead.
 * Backslashes go too: they are not an escape in Gmail's syntax and only ever
 * arrive from a model that thought they were.
 */
function quote(value: string): string {
  const cleaned = value.replaceAll('"', " ").replaceAll("\\", " ").trim().replace(/\s+/g, " ");
  return cleaned ? `"${cleaned}"` : "";
}

/**
 * Gmail's `after:` / `before:` take YYYY/MM/DD and are interpreted in the
 * account's own timezone, at day granularity. UTC is used here deliberately:
 * a day either side is the correct error to make on a search window, and
 * pretending to more precision than the operator has would be worse.
 *
 * `before:` is EXCLUSIVE of the named day, so a caller wanting to include
 * "today" must pass tomorrow — buildGmailQuery does that itself below.
 */
function gmailDate(atMs: number): string {
  const d = new Date(atMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}/${month}/${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildGmailQuery(input: GmailQueryInput): string {
  const terms: string[] = [];

  if (input.from) {
    const value = quote(input.from);
    if (value) terms.push(`from:${value}`);
  }
  if (input.subject) {
    const value = quote(input.subject);
    if (value) terms.push(`subject:${value}`);
  }
  if (input.gmailLabel) {
    // A labelId is machine-generated (SPAM, CATEGORY_PROMOTIONS) and the enum
    // in the catalogue is closed, so it needs no quoting — but it does need
    // the same defence against a value that never came from the enum.
    const value = input.gmailLabel.replace(/[^A-Za-z0-9_-]/g, "");
    if (value) terms.push(`label:${value}`);
  }
  if (input.afterMs !== undefined) {
    terms.push(`after:${gmailDate(input.afterMs)}`);
  }
  if (input.beforeMs !== undefined) {
    // Inclusive of the end day: see the note on gmailDate.
    terms.push(`before:${gmailDate(input.beforeMs + DAY_MS)}`);
  }
  if (input.query) {
    const value = quote(input.query);
    if (value) terms.push(value);
  }

  return terms.join(" ");
}

/**
 * The rungs a search climbs when the user says "keep looking".
 *
 * Fixed, so the WIDENING is deterministic rather than a number the model
 * invents each time. The renderer names the next rung and the model passes it
 * back, which is what makes "the 14 days before the 14 days I already
 * checked" expressible at all.
 */
export const SEARCH_LADDER = [7, 14, 30, 90, 365] as const;

/** The next rung past `days`, or null at the top of the ladder. */
export function nextRung(days: number): number | null {
  for (const rung of SEARCH_LADDER) {
    if (rung > days) return rung;
  }
  return null;
}

export interface SearchWindow {
  afterMs: number;
  beforeMs: number;
  withinDays: number;
  afterDays: number;
}

/**
 * Turn "within the last N days, but older than M days" into an instant pair.
 *
 * The half-open shape is the point: round one is {within:14, after:0} and
 * round two is {within:28, after:14}, so the second search CANNOT return what
 * the first already showed. Widening by raising `within` alone would re-list
 * everything each time, which is the behaviour being fixed.
 */
export function searchWindow(nowMs: number, withinDays: number, afterDays = 0): SearchWindow {
  const within = Math.max(1, withinDays);
  const after = Math.max(0, Math.min(afterDays, within - 1));
  return {
    afterMs: nowMs - within * DAY_MS,
    beforeMs: nowMs - after * DAY_MS,
    withinDays: within,
    afterDays: after,
  };
}
