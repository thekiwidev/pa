// Pure. No ctx, no fetch. Normalising a batch of things pulled out of a post
// before any of it is written anywhere.
//
// WHY A BATCH IS ITS OWN CONCEPT
//
// "Add these movies to my watchlist" is one instruction that becomes ten
// writes. Three things follow from that, and none of them is true of a single
// save:
//
//   1. The user has to see WHAT was found before it lands. Ten items pulled
//      off a misread carousel is ten pieces of wrong data in a store they
//      curate by hand.
//   2. Partial extraction must be visible. "I found 5" when the post had 10
//      is worse than useless, because it looks like an answer.
//   3. The list must survive the round trip to a button tap. The model must
//      not have to re-derive the items from a conversation transcript — that
//      is where items get silently dropped.
//
// So a batch is captured, shown, stored, and applied — never streamed
// straight into a write.

export type CaptureDestination = "notes" | "tasks";

export interface CaptureItem {
  /** The thing itself: a movie title, a task, a fact. */
  title: string;
  /** Anything worth keeping with it — a year, a director, a due date. */
  detail?: string;
}

/** Enough to be a real carousel; small enough that a card stays readable. */
export const MAX_CAPTURE_ITEMS = 30;

/** Length caps, so one runaway extraction cannot fill a Telegram card. */
const MAX_TITLE_CHARS = 200;
const MAX_DETAIL_CHARS = 500;

function tidy(value: string, cap: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, cap);
}

/** Case- and punctuation-insensitive, for spotting the same film twice. */
export function captureKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface NormalizedBatch {
  items: CaptureItem[];
  /** Titles dropped as duplicates, in the words they were proposed with. */
  duplicates: string[];
  /** How many were discarded for exceeding MAX_CAPTURE_ITEMS. */
  overflow: number;
}

/**
 * Clean a proposed batch without silently losing anything.
 *
 * Every reduction is REPORTED rather than applied quietly. A carousel that
 * yields the same title twice is common and worth collapsing; a carousel that
 * yields forty items is worth truncating. Doing either without saying so is
 * how "add all ten" turns into eight and nobody notices.
 */
export function normalizeBatch(raw: CaptureItem[]): NormalizedBatch {
  const items: CaptureItem[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const title = tidy(entry.title ?? "", MAX_TITLE_CHARS);
    if (!title) continue;

    const key = captureKey(title);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates.push(title);
      continue;
    }
    seen.add(key);

    const detail = entry.detail ? tidy(entry.detail, MAX_DETAIL_CHARS) : undefined;
    items.push(detail ? { title, detail } : { title });
  }

  const overflow = Math.max(0, items.length - MAX_CAPTURE_ITEMS);
  return { items: items.slice(0, MAX_CAPTURE_ITEMS), duplicates, overflow };
}

/**
 * The batch as one markdown document, for the notes destination.
 *
 * One note holding ten movies, rather than ten notes holding one each: a
 * watchlist is a list, and Notion search matches on titles, so ten near-
 * identical pages would be ten near-identical search hits.
 */
export function renderBatchMarkdown(
  items: CaptureItem[],
  source?: { url?: string; author?: string },
): string {
  const lines = items.map((item) =>
    item.detail ? `- **${item.title}** — ${item.detail}` : `- **${item.title}**`,
  );

  if (source?.url) {
    lines.push("", `Source: ${source.author ? `${source.author} — ` : ""}${source.url}`);
  }
  return lines.join("\n");
}

/** The one-line summary on the confirmation card. */
export function describeBatch(
  count: number,
  destination: CaptureDestination,
  category?: string,
): string {
  const noun = count === 1 ? "item" : "items";
  const where =
    destination === "tasks"
      ? category
        ? `your task board, labelled ${category}`
        : "your task board"
      : category
        ? `your ${category} notes`
        : "your notes";
  return `${count} ${noun} → ${where}`;
}
