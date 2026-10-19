// Load a downloaded Bible into Convex, so the assistant can send verses
// from it. docs/SCRIPTURE.md has where to download one and which formats.
//
//   bun scripts/import-bible.ts assets/bibles/KJV.json            # dev
//   bun scripts/import-bible.ts assets/bibles/KJV.json --prod     # production
//   bun scripts/import-bible.ts --all                             # every file in assets/bibles/
//   bun scripts/import-bible.ts assets/bibles/NIV.xml --check     # parse and verify only
//
// Options:
//   --code KJV          translation code (default: the code inside the file, else
//                       the file name, e.g. KJV.json → KJV)
//   --name "King …"     display name (default: the name inside the file, else the code)
//   --replace           re-import a translation that is already there
//   --prod              target the production deployment
//   --check             parse, report and verify the verse shelf; write nothing
//
// The parse is lib/scripture/parse.ts, the same code the unit tests cover.
// Verses go in with one `convex import --append` (seconds, not minutes);
// the translation row is written last, so a half-finished import is never
// picked to read from.

import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseBibleFile, type ParsedBible } from "../convex/lib/scripture/parse";
import { NEEDS, NEED_IDS } from "../convex/lib/scripture/needs";
import { formatReference, parseReference } from "../convex/lib/scripture/reference";

const ASSETS = "assets/bibles";
const BIBLE_EXTENSIONS = new Set([".json", ".xml", ".csv", ".osis", ".zefania"]);

interface Options {
  files: string[];
  code?: string;
  name?: string;
  replace: boolean;
  prod: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { files: [], replace: false, prod: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--code") opts.code = argv[++i];
    else if (arg === "--name") opts.name = argv[++i];
    else if (arg === "--replace") opts.replace = true;
    else if (arg === "--prod") opts.prod = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--all") {
      opts.files.push(
        ...readdirSync(ASSETS)
          .filter((f) => BIBLE_EXTENSIONS.has(extname(f).toLowerCase()))
          .map((f) => join(ASSETS, f)),
      );
    } else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if (opts.files.length === 0) fail("give a Bible file, or --all for every file in assets/bibles/");
  if (opts.code && opts.files.length > 1) fail("--code names one translation; import files one at a time with it");
  return opts;
}

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** "assets/bibles/KJV.json" → "KJV"; "web-bible.xml" → "WEBBIBLE". */
function codeFromFile(file: string): string {
  return basename(file, extname(file)).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function convex(args: string[], prod: boolean): string {
  const r = Bun.spawnSync(["bunx", "convex", ...args, ...(prod ? ["--prod"] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    fail(`convex ${args[0]} ${args[1] ?? ""} failed:\n${r.stderr.toString()}${r.stdout.toString()}`);
  }
  return r.stdout.toString().trim();
}

function run<T>(fn: string, args: Record<string, unknown>, prod: boolean): T {
  const out = convex(["run", fn, JSON.stringify(args)], prod);
  try {
    return JSON.parse(out) as T;
  } catch {
    return out as T;
  }
}

/** Every shelf reference in lib/scripture/needs.ts must exist in this Bible. */
function verifyShelf(bible: ParsedBible): string[] {
  const have = new Set(bible.verses.map((v) => `${v.book}:${v.chapter}:${v.verse}`));
  const missing: string[] = [];
  for (const id of NEED_IDS) {
    for (const ref of NEEDS[id].shelf) {
      const p = parseReference(ref);
      if (!p) {
        missing.push(`${ref} (unparseable)`);
        continue;
      }
      for (let v = p.verseStart; v <= p.verseEnd; v++) {
        if (!have.has(`${p.book}:${p.chapter}:${v}`)) {
          missing.push(formatReference(p));
          break;
        }
      }
    }
  }
  return missing;
}

async function importOne(file: string, opts: Options): Promise<void> {
  const started = Date.now();
  let bible: ParsedBible;
  try {
    bible = parseBibleFile(await Bun.file(file).text());
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const code = (opts.code ?? bible.code ?? codeFromFile(file)).toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(code)) fail(`"${code}" is not a usable code; pass --code, e.g. --code KJV`);
  const name = opts.name ?? bible.name ?? code;
  const books = new Set(bible.verses.map((v) => v.book)).size;
  console.log(
    `📖 ${file} → ${code} "${name}"\n   ${bible.format}: ${bible.verses.length.toLocaleString("en-US")} verses in ${books} books` +
      (bible.skipped ? `, ${bible.skipped} skipped (outside the 66 books, empty, or repeated)` : "") +
      ` — parsed in ${Date.now() - started}ms`,
  );
  if (books < 66) console.warn(`   ⚠ only ${books} of 66 books — a partial Bible (New Testament only?) still works, with fewer verses to choose from`);

  const missing = verifyShelf(bible);
  if (missing.length) console.warn(`   ⚠ ${missing.length} shelf verse(s) not in this Bible: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
  else console.log("   ✓ every hand-picked shelf verse is present");

  const sample = bible.verses.find((v) => v.book === 19 && v.chapter === 23 && v.verse === 1);
  if (sample) console.log(`   Psalm 23:1 — ${sample.text}`);

  if (opts.check) return;

  const exists = run<boolean>("model/scripture:hasVerses", { translation: code }, opts.prod);
  if (exists === true) {
    if (!opts.replace) fail(`${code} is already imported. Re-run with --replace to load it again.`);
    let deleted = 0;
    for (;;) {
      const r = run<{ deleted: number; more: boolean }>("model/scripture:deleteVersesBatch", { translation: code }, opts.prod);
      deleted += r.deleted;
      if (!r.more) break;
    }
    console.log(`   removed the old ${code} (${deleted.toLocaleString("en-US")} verses)`);
  }

  const jsonl = join(tmpdir(), `bible-${code}-${Date.now()}.jsonl`);
  await Bun.write(
    jsonl,
    bible.verses.map((v) => JSON.stringify({ translation: code, book: v.book, chapter: v.chapter, verse: v.verse, text: v.text })).join("\n") + "\n",
  );
  convex(["import", "--table", "bibleVerses", "--append", "--yes", jsonl], opts.prod);
  run("model/scripture:upsertTranslation", { code, name, format: bible.format, verseCount: bible.verses.length }, opts.prod);
  console.log(`   ✓ imported to ${opts.prod ? "production" : "dev"} in ${Math.round((Date.now() - started) / 1000)}s. "/scripture ${code}" reads from it.`);
}

const opts = parseArgs(process.argv.slice(2));
for (const file of opts.files) await importOne(file, opts);
