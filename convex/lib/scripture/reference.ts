// Pure. Bible references: "Phil 4:6-7" in, a typed passage out, and back.
//
// The model PROPOSES references; it never supplies verse text. Code parses
// the reference here and the text comes from the Bible the user imported,
// so a misremembered verse cannot reach the user (invariant 1 applied to
// scripture: the model proposes, the application disposes).

import { bookName, resolveBook } from "./books";

export interface Passage {
  book: number;
  chapter: number;
  verseStart: number;
  /** Inclusive. Equal to verseStart for a single verse. */
  verseEnd: number;
}

/** Longest passage ever sent. A devotional is a verse or two, not a chapter. */
export const MAX_PASSAGE_VERSES = 6;

const REF = /^\s*((?:[123]|i{1,3})?\s*[a-z][a-z .]*?)\s*(\d{1,3})\s*[:.]\s*(\d{1,3})(?:\s*[-–—]\s*(?:(\d{1,3})\s*[:.]\s*)?(\d{1,3}))?\s*$/i;

/**
 * "Psalm 23:1", "1 Cor 13:4-7", "Isaiah 41:10–13", "Rom. 8:28", "II Timothy
 * 1:7". A range crossing a chapter ("John 3:16-4:2") is cut at the first
 * chapter's verse, because a devotional never needs one. Ranges longer than
 * MAX_PASSAGE_VERSES are trimmed. Returns null for anything else.
 */
export function parseReference(raw: string): Passage | null {
  const m = REF.exec(raw.replace(/\s+/g, " "));
  if (!m) return null;
  const book = resolveBook(m[1]!);
  if (book === null) return null;
  const chapter = Number(m[2]);
  const verseStart = Number(m[3]);
  const endChapter = m[4] === undefined ? chapter : Number(m[4]);
  let verseEnd = m[5] === undefined ? verseStart : Number(m[5]);
  if (chapter < 1 || verseStart < 1) return null;
  if (endChapter !== chapter) verseEnd = verseStart; // cross-chapter → first verse only
  if (verseEnd < verseStart) verseEnd = verseStart;
  verseEnd = Math.min(verseEnd, verseStart + MAX_PASSAGE_VERSES - 1);
  return { book, chapter, verseStart, verseEnd };
}

/** "Psalm 23:1-3" — en dash for a range, as printed Bibles write it. */
export function formatReference(p: Passage): string {
  const range = p.verseEnd > p.verseStart ? `${p.verseStart}–${p.verseEnd}` : `${p.verseStart}`;
  return `${bookName(p.book)} ${p.chapter}:${range}`;
}

/** A stable identity for "was this sent recently?": "19:23:1-3". */
export function passageKey(p: Passage): string {
  return `${p.book}:${p.chapter}:${p.verseStart}-${p.verseEnd}`;
}

/** Two passages share a verse. Psalm 23:1 and Psalm 23:1-3 overlap. */
export function overlaps(a: Passage, b: Passage): boolean {
  return a.book === b.book && a.chapter === b.chapter && a.verseStart <= b.verseEnd && b.verseStart <= a.verseEnd;
}
