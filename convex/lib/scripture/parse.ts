// Pure. A downloaded Bible file → one flat list of verses.
//
// There is no single Bible format, so this reads the ones free Bibles are
// actually published in (checked 2026-10-19 against the live files):
//
//   scrollmapper   github.com/scrollmapper/bible_databases  formats/json/*.json
//                  { translation, books: [{ name, chapters: [{ chapter, verses: [{ verse, text }] }] }] }
//   thiagobodruk   github.com/thiagobodruk/bible  json/*.json
//                  [{ abbrev, name, chapters: [["v1", "v2", …], …] }]   (66 books, in order)
//   flat JSON      [{ book, chapter, verse, text }] or { verses: [...] }
//                  — Bible SuperSearch's export is this, with { metadata: { name, shortname } }
//   Beblia XML     github.com/Beblia/Holy-Bible-XML-Format
//                  <bible><testament><book number><chapter number><verse number>
//   Zefania XML    <XMLBIBLE><BIBLEBOOK bnumber><CHAPTER cnumber><VERS vnumber>
//   OSIS XML       <verse osisID="Gen.1.1">…</verse> (container or milestone)
//   CSV            a header row naming book, chapter, verse and text columns
//
// No DOM: Convex's V8 runtime and `bun test` both lack DOMParser, and these
// formats are regular enough that a tag scan is exact.

import { resolveBook } from "./books";

export interface VerseRow {
  book: number;
  chapter: number;
  verse: number;
  text: string;
}

export type BibleFormat =
  | "scrollmapper"
  | "thiagobodruk"
  | "flat-json"
  | "beblia-xml"
  | "zefania-xml"
  | "osis-xml"
  | "csv";

export interface ParsedBible {
  format: BibleFormat;
  /** The translation's own name, when the file carries one. */
  name?: string;
  /** Its short code ("KJV"), when the file carries one. */
  code?: string;
  verses: VerseRow[];
  /** Verses dropped: a book outside the 66 (Apocrypha), empty text, a duplicate. */
  skipped: number;
}

export class BibleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BibleParseError";
  }
}

/** Decide the format from the content, not the file name. */
export function parseBibleFile(content: string): ParsedBible {
  const text = content.replace(/^﻿/, "").trim();
  if (text.startsWith("{") || text.startsWith("[")) return parseJsonBible(text);
  if (text.startsWith("<")) return parseXmlBible(text);
  return parseCsvBible(text);
}

/* ── text cleanup ─────────────────────────────────────────────── */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Plain reading text. Footnotes and cross-references go entirely; markup
 * around words (Strong's numbers, italics, red letters) goes but the words
 * stay. KJV files print translator-supplied words as "[but]" — the brackets
 * go, the word stays, as it reads aloud.
 */
export function cleanVerseText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<(note|NOTE|rdg|RDG|footnote|xref|XREF)\b[^>]*>[\s\S]*?<\/\1>/g, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\{[HG]\d+[a-z]?\}/g, "")
    .replace(/[¶‹›]/g, "") // paragraph marks; ‹ › are Bible SuperSearch red letters
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/* ── collecting ───────────────────────────────────────────────── */

class Collector {
  private readonly seen = new Set<string>();
  readonly verses: VerseRow[] = [];
  skipped = 0;

  add(book: number | null, chapter: unknown, verse: unknown, rawText: unknown): void {
    const c = Number(chapter);
    const v = Number(verse);
    const text = typeof rawText === "string" ? cleanVerseText(rawText) : "";
    if (book === null || book < 1 || book > 66 || !Number.isInteger(c) || !Number.isInteger(v) || c < 1 || v < 1 || !text) {
      this.skipped++;
      return;
    }
    const key = `${book}:${c}:${v}`;
    if (this.seen.has(key)) {
      this.skipped++;
      return;
    }
    this.seen.add(key);
    this.verses.push({ book, chapter: c, verse: v, text });
  }

  done(format: BibleFormat, name?: string, code?: string): ParsedBible {
    if (this.verses.length === 0) {
      throw new BibleParseError(`read the file as ${format} but found no verses in it`);
    }
    return { format, ...(name ? { name } : {}), ...(code ? { code } : {}), verses: this.verses, skipped: this.skipped };
  }
}

/** A book given as a number (1-66) or a name. */
function bookOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return resolveBook(trimmed);
}

/* ── JSON ─────────────────────────────────────────────────────── */

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined) return row[k];
  return undefined;
}

function parseJsonBible(text: string): ParsedBible {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BibleParseError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out = new Collector();
  const obj = (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}) as Record<string, unknown>;

  // scrollmapper: { translation, books: [{ name, chapters: [{ chapter, verses }] }] }
  if (Array.isArray(obj.books)) {
    (obj.books as unknown[]).forEach((b, index) => {
      const book = b as Record<string, unknown>;
      const n = bookOf(pick(book, ["name", "book", "bookName"])) ?? bookOf(pick(book, ["number", "id"])) ?? index + 1;
      for (const ch of (book.chapters as unknown[]) ?? []) {
        const chapter = ch as Record<string, unknown>;
        for (const vs of (chapter.verses as unknown[]) ?? []) {
          const verse = vs as Record<string, unknown>;
          out.add(n, chapter.chapter, verse.verse, verse.text);
        }
      }
    });
    return out.done("scrollmapper", typeof obj.translation === "string" ? obj.translation : undefined);
  }

  // scrollmapper's older export: { resultset: { row: [{ field: [id, book, chapter, verse, text] }] } }
  const resultset = obj.resultset as { row?: { field?: unknown[] }[] } | undefined;
  if (resultset && Array.isArray(resultset.row)) {
    for (const row of resultset.row) {
      const f = row.field ?? [];
      out.add(bookOf(f[1]), f[2], f[3], f[4]);
    }
    return out.done("flat-json");
  }

  const rows = Array.isArray(data) ? data : Array.isArray(obj.verses) ? (obj.verses as unknown[]) : null;
  if (!rows) throw new BibleParseError("JSON, but not a Bible layout I know (expected books[], verses[] or an array)");

  // thiagobodruk: [{ abbrev, chapters: [[ "text", … ]] }] — books by position.
  const first = rows[0] as Record<string, unknown> | undefined;
  if (first && Array.isArray(first.chapters) && Array.isArray((first.chapters as unknown[])[0])) {
    rows.forEach((b, index) => {
      const chapters = ((b as Record<string, unknown>).chapters as unknown[][]) ?? [];
      chapters.forEach((verses, ci) => {
        (verses ?? []).forEach((t, vi) => out.add(index + 1, ci + 1, vi + 1, t));
      });
    });
    return out.done("thiagobodruk");
  }

  // Flat rows, with whichever key names the exporter liked.
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const book = bookOf(pick(row, ["book", "book_id", "bookId", "book_number", "b", "book_name", "bookName"]));
    out.add(book, pick(row, ["chapter", "c", "chapter_number"]), pick(row, ["verse", "v", "verse_number"]), pick(row, ["text", "t", "content"]));
  }
  const meta = (typeof obj.metadata === "object" && obj.metadata !== null ? obj.metadata : {}) as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : typeof obj.translation === "string" ? obj.translation : undefined;
  const code = typeof meta.shortname === "string" && /^[A-Za-z0-9]{2,16}$/.test(meta.shortname) ? meta.shortname.toUpperCase() : undefined;
  return out.done("flat-json", name, code);
}

/* ── XML ──────────────────────────────────────────────────────── */

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function parseXmlBible(text: string): ParsedBible {
  if (/<XMLBIBLE\b/i.test(text) || /<BIBLEBOOK\b/i.test(text)) return parseZefania(text);
  if (/osisID\s*=/.test(text)) return parseOsis(text);
  if (/<bible\b/i.test(text) && /<verse\b/i.test(text)) return parseBeblia(text);
  throw new BibleParseError("XML, but not Beblia, Zefania or OSIS");
}

/** Walk <book>/<chapter>/<verse> style nesting with one tag scan. */
function parseNested(
  text: string,
  tags: { book: string; chapter: string; verse: string },
  attrs: { book: string[]; chapter: string; verse: string },
  out: Collector,
): void {
  const re = new RegExp(
    `<(${tags.book}|${tags.chapter})\\b([^>]*)>|<${tags.verse}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tags.verse}>)`,
    "gi",
  );
  let book: number | null = null;
  let chapter = 0;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      const tag = `<${m[1]}${m[2]}>`;
      if (m[1].toLowerCase() === tags.book.toLowerCase()) {
        book = null;
        for (const a of attrs.book) {
          const value = attr(tag, a);
          if (value !== undefined) {
            book = bookOf(value);
            if (book !== null) break;
          }
        }
        chapter = 0;
      } else {
        chapter = Number(attr(tag, attrs.chapter) ?? 0);
      }
      continue;
    }
    out.add(book, chapter, attr(`<v${m[3]}>`, attrs.verse), m[4] ?? "");
  }
}

function parseBeblia(text: string): ParsedBible {
  const out = new Collector();
  parseNested(text, { book: "book", chapter: "chapter", verse: "verse" }, { book: ["number", "name"], chapter: "number", verse: "number" }, out);
  return out.done("beblia-xml", attr(/<bible\b[^>]*>/i.exec(text)?.[0] ?? "", "translation"));
}

function parseZefania(text: string): ParsedBible {
  const out = new Collector();
  parseNested(
    text,
    { book: "BIBLEBOOK", chapter: "CHAPTER", verse: "VERS" },
    { book: ["bnumber", "bname", "bsname"], chapter: "cnumber", verse: "vnumber" },
    out,
  );
  const header = /<XMLBIBLE\b[^>]*>/i.exec(text)?.[0] ?? "";
  const title = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  return out.done("zefania-xml", attr(header, "biblename") ?? (title ? cleanVerseText(title) : undefined));
}

/** osisID "Gen.1.1" (or "Ps.23.1 Ps.23.2" for a combined verse — first wins). */
function osisRef(id: string): { book: number | null; chapter: number; verse: number } | null {
  const m = /^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)/.exec(id.trim());
  if (!m) return null;
  return { book: resolveBook(m[1]!), chapter: Number(m[2]), verse: Number(m[3]) };
}

function parseOsis(text: string): ParsedBible {
  const out = new Collector();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  const name = title ? cleanVerseText(title) : undefined;

  if (/<verse\b[^>]*\bsID\s*=/.test(text)) {
    // Milestones: text runs from <verse sID=…/> to the matching <verse eID=…/>.
    const re = /<verse\b([^>]*)\bsID\s*=\s*"([^"]+)"([^>]*)\/>([\s\S]*?)<verse\b[^>]*\beID\s*=\s*"\2"[^>]*\/>/g;
    for (const m of text.matchAll(re)) {
      const id = attr(`<v${m[1]}${m[3]}>`, "osisID");
      const ref = id ? osisRef(id) : null;
      if (!ref) {
        out.skipped++;
        continue;
      }
      out.add(ref.book, ref.chapter, ref.verse, m[4]);
    }
    return out.done("osis-xml", name);
  }

  for (const m of text.matchAll(/<verse\b([^>]*)>([\s\S]*?)<\/verse>/g)) {
    const id = attr(`<v${m[1]}>`, "osisID");
    const ref = id ? osisRef(id) : null;
    if (!ref) {
      out.skipped++;
      continue;
    }
    out.add(ref.book, ref.chapter, ref.verse, m[2]);
  }
  return out.done("osis-xml", name);
}

/* ── CSV ──────────────────────────────────────────────────────── */

/** RFC 4180 rows: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function parseCsvBible(text: string): ParsedBible {
  const rows = csvRows(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const b = col(["book", "book_name", "book_id", "book_number", "b"]);
  const c = col(["chapter", "c"]);
  const v = col(["verse", "v"]);
  const t = col(["text", "t", "content"]);
  if (b < 0 || c < 0 || v < 0 || t < 0) {
    throw new BibleParseError("not JSON or XML, and not a CSV with book, chapter, verse and text columns");
  }
  const out = new Collector();
  for (const row of rows.slice(1)) out.add(bookOf(row[b]), row[c], row[v], row[t]);
  return out.done("csv");
}
