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

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL, (ch) => `\\${ch}`);
}
