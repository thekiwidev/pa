// Pure. Splitting an already-converted HTML message into sendable parts.
//
// WHY THIS EXISTS
//
// channels/telegram.ts used to slice raw markdown at 4096 and convert to HTML
// AFTERWARDS. Two things went wrong with that, both observed live:
//
//   - The slice happened before conversion, so a cut landing inside "**" left
//     an unbalanced tag. Telegram rejects the WHOLE message with a 400 on an
//     unbalanced tag, the send path caught it and retried with no parse_mode —
//     and the user saw a long message with every asterisk visible. The
//     formatting looked broken at random, which is exactly how it was
//     reported.
//   - Conversion GROWS the text ("&" -> "&amp;", plus every tag), so a body
//     trimmed to fit could exceed the limit again after conversion.
//
// Converting first and splitting here fixes both. Splitting rather than
// truncating also matters for correctness elsewhere: a draft preview must show
// the user the whole body an approval will bind itself to.

/** Telegram's documented per-message limit. */
export const TELEGRAM_MAX_LEN = 4096;

/** Tags Telegram accepts that carry attributes worth preserving on reopen. */
const VOIDLESS_TAG = /<(\/?)([a-z]+)((?:\s[^>]*)?)>/g;

interface OpenTag {
  name: string;
  /** The full opening tag, so `<a href="…">` reopens with its href intact. */
  raw: string;
}

/**
 * Split HTML into parts that each fit Telegram's limit, each independently
 * well-formed.
 *
 * Boundary preference, best first: blank line, then newline, then a hard cut.
 * A hard cut never lands inside a tag or an &entity;.
 *
 * Any tag still open at a boundary is closed at the end of the part and
 * reopened at the start of the next, so no part is ever unbalanced.
 */
export function splitTelegramHtml(html: string): string[] {
  if (html.trim().length === 0) return [];
  if (html.length <= TELEGRAM_MAX_LEN) return [html];

  const parts: string[] = [];
  let rest = html;
  let carried: OpenTag[] = [];

  while (rest.length > 0) {
    const prefix = carried.map((t) => t.raw).join("");

    if (prefix.length + rest.length <= TELEGRAM_MAX_LEN) {
      parts.push(prefix + rest);
      break;
    }

    // How much room the closing tags need cannot be known until we know where
    // the cut lands, because the chunk itself may open tags. So: cut, measure,
    // and shrink the budget by the overflow. This converges in one or two
    // passes for any realistic message.
    let budget = TELEGRAM_MAX_LEN - prefix.length;
    let chunk = "";
    let open: OpenTag[] = [];
    let suffix = "";

    for (let attempt = 0; attempt < 8; attempt++) {
      const cut = findCut(rest, budget);
      chunk = rest.slice(0, cut);
      open = openTagsAfter(carried, chunk);
      suffix = open.map((t) => `</${t.name}>`).reverse().join("");

      const overflow = prefix.length + chunk.length + suffix.length - TELEGRAM_MAX_LEN;
      if (overflow <= 0) break;

      budget -= overflow;
      // Degenerate case — nesting so deep the tags leave no useful room.
      // Drop tag preservation rather than loop forever.
      if (budget < 64) {
        chunk = rest.slice(0, Math.max(1, TELEGRAM_MAX_LEN - prefix.length));
        open = [];
        suffix = "";
        break;
      }
    }

    parts.push(prefix + chunk + suffix);
    rest = rest.slice(chunk.length).replace(/^\n+/, "");
    carried = open;
  }

  return parts;
}

/**
 * Where to cut `text` so the piece is at most `budget` characters.
 *
 * Never returns a position inside a `<tag>` or an `&entity;` — a half tag
 * breaks the parse, and a half entity renders as literal "&am".
 */
function findCut(text: string, budget: number): number {
  const window = text.slice(0, budget);

  for (const boundary of ["\n\n", "\n"]) {
    const at = window.lastIndexOf(boundary);
    // Only honour a boundary that keeps a reasonable amount of content;
    // otherwise a stray early newline would produce a near-empty part. The
    // separator itself is left on `rest` and stripped by the caller, so no
    // part carries a trailing blank line.
    if (at > budget * 0.5) return at;
  }

  return safeHardCut(window);
}

/** Walk back off an unterminated `<…` or `&…` so a cut never lands inside one. */
function safeHardCut(window: string): number {
  let cut = window.length;

  const lastLt = window.lastIndexOf("<");
  if (lastLt !== -1 && window.indexOf(">", lastLt) === -1) cut = Math.min(cut, lastLt);

  const lastAmp = window.lastIndexOf("&");
  if (lastAmp !== -1 && window.indexOf(";", lastAmp) === -1) cut = Math.min(cut, lastAmp);

  // A pathological window (one enormous tag) still has to make progress.
  return cut > 0 ? cut : window.length;
}

/** The tags left open after `chunk`, starting from those already carried. */
function openTagsAfter(carried: OpenTag[], chunk: string): OpenTag[] {
  const stack = [...carried];

  for (const m of chunk.matchAll(VOIDLESS_TAG)) {
    const slash = m[1] ?? "";
    const name = m[2] ?? "";
    const attrs = m[3] ?? "";
    if (slash) {
      // Tolerate a stray close rather than throwing: this runs on every
      // outbound message and a malformed input should degrade, not 500.
      const at = stack.map((t) => t.name).lastIndexOf(name);
      if (at !== -1) stack.splice(at, 1);
    } else {
      stack.push({ name, raw: `<${name}${attrs}>` });
    }
  }

  return stack;
}
