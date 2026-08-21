// Pure. No ctx, no fetch.
//
// Telegram's MarkdownV2 parse_mode treats 18 characters as syntax:
//   _ * [ ] ( ) ~ ` > # + - = | { } . !
// plus the backslash itself, since backslash is the escape character. Any
// literal occurrence of one of these in message text must be backslash-
// escaped, or Telegram either rejects the whole sendMessage/editMessageText
// call with "can't parse entities" or -- worse -- silently opens formatting
// (a bracket becomes a link entity) that the source text never intended.
//
// Phase 1's sendMessage sent no parse_mode specifically so nothing needed
// escaping. sendCard and editCard (Step 9) are what change that, so from
// this phase on every field built from email content -- subject, sender
// name, an AI-generated rationale -- MUST run through this first.

const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * A string that has been through escapeMarkdownV2, or was assembled by
 * someone who checked. sendCard/editCard accept ONLY this type.
 *
 * The reason it exists: "remember to escape before sending" failed twice —
 * once in composeCard (escaped the parts, not the punctuation joining them)
 * and once in the router's approval card (escaped nothing). Both surfaced as
 * a Telegram 400 at runtime, on the one path where a user was waiting. A
 * brand turns both into a compile error.
 */
export type EscapedMarkdown = string & { readonly __escapedMarkdownV2: unique symbol };

export function escapeMarkdownV2(text: string): EscapedMarkdown {
  return text.replace(SPECIAL, (ch) => `\\${ch}`) as EscapedMarkdown;
}

/**
 * Assert that an assembled string is already safe.
 *
 * Use ONLY where every interpolated value was escaped individually AND every
 * literal character between them is non-special — composeCard is the one
 * legitimate caller. If you reach for this to silence a type error, escape
 * the whole composed string instead; that is what the second bug was.
 */
export function alreadyEscaped(text: string): EscapedMarkdown {
  return text as EscapedMarkdown;
}
