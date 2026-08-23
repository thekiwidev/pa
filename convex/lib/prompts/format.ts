// Pure. The one statement of what user-facing output may look like.
//
// WHY THIS EXISTS
//
// No prompt in this project stated an output format. The model picked one —
// markdown with "###" headings, "---" rules and tables — and Telegram renders
// none of those, so they reached the user literally. The converter now handles
// headings and rules (lib/telegram/richtext.ts), but a converter can only
// rescue syntax it anticipates; a table cannot be rescued at all, because
// Telegram has no table.
//
// So: fix the converter AND stop generating what cannot render. Belt and
// braces, on the path every outbound message takes.

/**
 * Appended to every prompt whose output is shown to the user in Telegram.
 *
 * Deliberately short. A long formatting section competes for attention with
 * the actual task, and the converter is the real guarantee — this only has to
 * stop the constructs that cannot be converted at all.
 */
export const TELEGRAM_FORMAT_CONTRACT = `FORMAT — you are writing for Telegram, not a web page:
- **bold** for emphasis and for anything you would have made a heading.
  Telegram has NO headings — never write "#", "##" or "###".
- "- " for bullets. Never a table: Telegram cannot render one, and a table
  arrives as unreadable pipes. Use bullets or short labelled lines instead.
- A blank line separates sections. Never "---" or "***" as a divider.
- Keep links as [text](url). Plain URLs are fine too.
- No code fences unless you are actually showing code.`;
