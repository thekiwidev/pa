// Pure. The 66 books of the Protestant canon, numbered 1-66 in canonical
// order, and the one function that turns whatever a Bible file or a model
// calls a book into that number.
//
// Every downloaded format spells books differently: scrollmapper writes
// "I Samuel" and "Revelation of John", thiagobodruk writes Portuguese names
// with English text, Beblia and Zefania use numbers. Storing the NUMBER is
// what lets one reference ("Psalm 23:1") resolve in every translation.

export interface Book {
  /** 1 = Genesis … 66 = Revelation. */
  n: number;
  /** How a reference is written back to the user. */
  name: string;
  /** Extra spellings, lower-case, already normalised (see normalizeBookName). */
  aliases: string[];
}

export const BOOKS: Book[] = [
  { n: 1, name: "Genesis", aliases: ["gen", "ge", "gn"] },
  { n: 2, name: "Exodus", aliases: ["exod", "exo", "ex"] },
  { n: 3, name: "Leviticus", aliases: ["lev", "le", "lv"] },
  { n: 4, name: "Numbers", aliases: ["num", "nu", "nm", "nb"] },
  { n: 5, name: "Deuteronomy", aliases: ["deut", "deu", "dt"] },
  { n: 6, name: "Joshua", aliases: ["josh", "jos", "jsh"] },
  { n: 7, name: "Judges", aliases: ["judg", "jdg", "jg", "jdgs"] },
  { n: 8, name: "Ruth", aliases: ["rth", "ru"] },
  { n: 9, name: "1 Samuel", aliases: ["1 sam", "1 sa", "1sm", "1 s"] },
  { n: 10, name: "2 Samuel", aliases: ["2 sam", "2 sa", "2sm", "2 s"] },
  { n: 11, name: "1 Kings", aliases: ["1 kgs", "1 ki", "1 kin", "1 k"] },
  { n: 12, name: "2 Kings", aliases: ["2 kgs", "2 ki", "2 kin", "2 k"] },
  { n: 13, name: "1 Chronicles", aliases: ["1 chron", "1 chr", "1 ch"] },
  { n: 14, name: "2 Chronicles", aliases: ["2 chron", "2 chr", "2 ch"] },
  { n: 15, name: "Ezra", aliases: ["ezr", "ez"] },
  { n: 16, name: "Nehemiah", aliases: ["neh", "ne"] },
  { n: 17, name: "Esther", aliases: ["esth", "est", "es"] },
  { n: 18, name: "Job", aliases: ["jb"] },
  { n: 19, name: "Psalm", aliases: ["psalms", "ps", "psa", "pss", "psm", "pslm"] },
  { n: 20, name: "Proverbs", aliases: ["prov", "pro", "prv", "pr"] },
  { n: 21, name: "Ecclesiastes", aliases: ["eccles", "eccl", "ecc", "ec", "qoheleth"] },
  { n: 22, name: "Song of Solomon", aliases: ["song of songs", "song", "sos", "so", "canticles", "cant", "sg"] },
  { n: 23, name: "Isaiah", aliases: ["isa", "is"] },
  { n: 24, name: "Jeremiah", aliases: ["jer", "je", "jr"] },
  { n: 25, name: "Lamentations", aliases: ["lam", "la"] },
  { n: 26, name: "Ezekiel", aliases: ["ezek", "eze", "ezk"] },
  { n: 27, name: "Daniel", aliases: ["dan", "da", "dn"] },
  { n: 28, name: "Hosea", aliases: ["hos", "ho"] },
  { n: 29, name: "Joel", aliases: ["jl"] },
  { n: 30, name: "Amos", aliases: ["am"] },
  { n: 31, name: "Obadiah", aliases: ["obad", "ob"] },
  { n: 32, name: "Jonah", aliases: ["jon", "jnh"] },
  { n: 33, name: "Micah", aliases: ["mic", "mc"] },
  { n: 34, name: "Nahum", aliases: ["nah", "na"] },
  { n: 35, name: "Habakkuk", aliases: ["hab", "hb"] },
  { n: 36, name: "Zephaniah", aliases: ["zeph", "zep", "zp"] },
  { n: 37, name: "Haggai", aliases: ["hag", "hg"] },
  { n: 38, name: "Zechariah", aliases: ["zech", "zec", "zc"] },
  { n: 39, name: "Malachi", aliases: ["mal", "ml"] },
  { n: 40, name: "Matthew", aliases: ["matt", "mat", "mt"] },
  { n: 41, name: "Mark", aliases: ["mrk", "mar", "mk", "mr"] },
  { n: 42, name: "Luke", aliases: ["luk", "lk"] },
  { n: 43, name: "John", aliases: ["joh", "jhn", "jn"] },
  { n: 44, name: "Acts", aliases: ["act", "ac", "acts of the apostles"] },
  { n: 45, name: "Romans", aliases: ["rom", "ro", "rm"] },
  { n: 46, name: "1 Corinthians", aliases: ["1 cor", "1 co"] },
  { n: 47, name: "2 Corinthians", aliases: ["2 cor", "2 co"] },
  { n: 48, name: "Galatians", aliases: ["gal", "ga"] },
  { n: 49, name: "Ephesians", aliases: ["eph", "ephes"] },
  { n: 50, name: "Philippians", aliases: ["phil", "php", "pp"] },
  { n: 51, name: "Colossians", aliases: ["col", "co"] },
  { n: 52, name: "1 Thessalonians", aliases: ["1 thess", "1 thes", "1 th"] },
  { n: 53, name: "2 Thessalonians", aliases: ["2 thess", "2 thes", "2 th"] },
  { n: 54, name: "1 Timothy", aliases: ["1 tim", "1 ti"] },
  { n: 55, name: "2 Timothy", aliases: ["2 tim", "2 ti"] },
  { n: 56, name: "Titus", aliases: ["tit", "ti"] },
  { n: 57, name: "Philemon", aliases: ["philem", "phlm", "phm", "pm"] },
  { n: 58, name: "Hebrews", aliases: ["heb"] },
  { n: 59, name: "James", aliases: ["jas", "jm"] },
  { n: 60, name: "1 Peter", aliases: ["1 pet", "1 pe", "1 pt", "1 p"] },
  { n: 61, name: "2 Peter", aliases: ["2 pet", "2 pe", "2 pt", "2 p"] },
  { n: 62, name: "1 John", aliases: ["1 jn", "1 jhn", "1 jo", "1 j"] },
  { n: 63, name: "2 John", aliases: ["2 jn", "2 jhn", "2 jo", "2 j"] },
  { n: 64, name: "3 John", aliases: ["3 jn", "3 jhn", "3 jo", "3 j"] },
  { n: 65, name: "Jude", aliases: ["jud", "jd"] },
  { n: 66, name: "Revelation", aliases: ["revelations", "rev", "re", "rv", "revelation of john", "apocalypse", "the revelation"] },
];

/**
 * Lower-case, no dots, "I/II/III" and "First/Second/Third" turned into
 * "1/2/3", a space between that number and the name, and the "Book of" and
 * "Saint" prefixes some files carry dropped.
 */
export function normalizeBookName(raw: string): string {
  let s = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(the )?(first|second|third) (book of |epistle of )?/, (_m, _t, ord: string) =>
    ord === "first" ? "1 " : ord === "second" ? "2 " : "3 ",
  );
  s = s.replace(/^(iii|ii|i)(?= )/, (r) => String(r.length));
  s = s.replace(/^([123])([a-z])/, "$1 $2");
  s = s.replace(/^(the )?(book|gospel|epistle) (of |according to )(saint |st )?/, "");
  s = s.replace(/^(saint |st )/, "");
  return s.trim();
}

const BY_NAME: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (const book of BOOKS) {
    map.set(normalizeBookName(book.name), book.n);
    for (const alias of book.aliases) map.set(normalizeBookName(alias), book.n);
  }
  return map;
})();

/** Book number for any common spelling, or null. */
export function resolveBook(raw: string): number | null {
  const key = normalizeBookName(raw);
  if (!key) return null;
  const direct = BY_NAME.get(key);
  if (direct !== undefined) return direct;
  // "1 Corinthians" written "1corinthians" or "Psalms of David" — drop a
  // trailing "of …" qualifier and try again.
  const trimmed = key.replace(/ of [a-z ]+$/, "");
  return BY_NAME.get(trimmed) ?? null;
}

export function bookName(n: number): string {
  return BOOKS[n - 1]?.name ?? `Book ${n}`;
}
