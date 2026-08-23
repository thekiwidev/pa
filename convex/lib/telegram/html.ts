// Pure. The escaping half of Telegram's HTML parse_mode.
//
// Replaces lib/telegram/markdown.ts. The brand and its rationale carry over
// unchanged (MEMORY.md, 2026-08-21): two runtime 400s, three days apart, both
// "a string reached sendCard without being escaped". The fix was not a third
// reminder — `escape` returns a branded type and sendCard/editCard accept only
// that, so an unescaped string no longer compiles.
//
// What changed is the target syntax. MarkdownV2 needs eighteen characters
// escaped and silently 400s the WHOLE message on any miss; HTML needs three.
// Cards were the last MarkdownV2 holdout, so retiring it leaves exactly one
// formatting system on every outbound path.

/**
 * Text that is safe to hand to Telegram with parse_mode: "HTML".
 *
 * Produced by `escapeTelegramHtml` (escapes everything) or `alreadyHtml`
 * (asserts a composed string is safe). The `unique symbol` makes the brand
 * unforgeable by structural typing.
 */
export type TelegramHtml = string & { readonly __telegramHtml: unique symbol };

/**
 * Telegram's HTML mode understands only b, i, u, s, code, pre, blockquote and
 * a. Everything else is literal text, so only these three characters can
 * break a parse or inject markup.
 */
export function escapeTelegramHtml(text: string): TelegramHtml {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;") as TelegramHtml;
}

/**
 * Assert that an already-composed string is valid Telegram HTML.
 *
 * The deliberate escape hatch, for a builder that escaped each field and then
 * added its own tags — composeCard in convex/notify.ts is the intended caller.
 *
 * If you reach for this to silence a type error, that is the bug: escape the
 * untrusted PARTS and let the composed string be built from them. The 400 that
 * motivated the brand came from a composed string whose parts were escaped and
 * whose joining characters were not.
 */
export function alreadyHtml(text: string): TelegramHtml {
  return text as TelegramHtml;
}

/** Telegram rejects messages over 4096 UTF-16 code units. */
export const TELEGRAM_MAX_LEN = 4096;

/**
 * Cap a card at the message limit.
 *
 * A card carries buttons, so it cannot be split across messages the way an
 * ordinary reply is — truncation is the only option. The cut walks back off a
 * partial tag or entity so a truncated card still parses.
 */
export function capCard(text: TelegramHtml): string {
  if (text.length <= TELEGRAM_MAX_LEN) return text;

  const window = text.slice(0, TELEGRAM_MAX_LEN - 1);
  let cut = window.length;

  const lastLt = window.lastIndexOf("<");
  if (lastLt !== -1 && window.indexOf(">", lastLt) === -1) cut = Math.min(cut, lastLt);

  const lastAmp = window.lastIndexOf("&");
  if (lastAmp !== -1 && window.indexOf(";", lastAmp) === -1) cut = Math.min(cut, lastAmp);

  return `${window.slice(0, cut)}…`;
}
