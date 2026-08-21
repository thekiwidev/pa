// Pure. No ctx, no fetch.
//
// The model writes ordinary Markdown. Telegram does not render Markdown
// unless a parse_mode is set, and Phase 1's sendMessage sets none (so that
// nothing needs escaping) — which meant "**bold**" reached the user with the
// asterisks visible.
//
// This converts that Markdown to Telegram's HTML parse_mode rather than
// MarkdownV2, deliberately: HTML needs exactly three characters escaped
// (& < >), where MarkdownV2 needs eighteen and has already caused two
// production 400s in this project. Fewer escape rules is fewer ways to be
// wrong on a path that every single reply goes through.

/** Telegram's HTML mode understands only b, i, u, s, code, pre and a.
 *  Everything else is literal text, so only these three need escaping. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A marker no plausible message contains, used to park converted spans so a
 * later rule cannot reach inside one. Printable on purpose — a control
 * character here is invisible in logs and diffs when it leaks.
 */
const HOLD_OPEN = "␂HOLD";
const HOLD_CLOSE = "␃";

/**
 * Markdown -> Telegram HTML.
 *
 * Order matters: fenced blocks first (their contents must not be re-parsed
 * as markdown), then inline code, then links, then emphasis.
 *
 * An unmatched marker is left as literal text. Telegram rejects the WHOLE
 * message with a 400 on an unbalanced tag, so "2 * 3 = 6" must never open an
 * <i> — every rule below requires a matching close on the same line.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };

  let text = markdown;

  // 1. Fenced code blocks. The language tag is dropped; Telegram ignores it.
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, body: string) =>
    hold(`<pre>${escapeHtml(body.replace(/\n$/, ""))}</pre>`),
  );

  // 2. Inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    hold(`<code>${escapeHtml(body)}</code>`),
  );

  // 3. Links, before emphasis so a URL's underscores are not italicised.
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, href: string) =>
      hold(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`),
  );

  // 4. Bold before italic — otherwise ** is consumed as two single markers.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) =>
    hold(`<b>${escapeHtml(body)}</b>`),
  );
  text = text.replace(/__([^_\n]+)__/g, (_m, body: string) =>
    hold(`<b>${escapeHtml(body)}</b>`),
  );

  // 5. Italic. Requires a non-space immediately inside the markers, so
  //    arithmetic ("2 * 3 = 6") and bare list bullets are left alone.
  text = text.replace(
    /(^|[\s(])\*(\S[^*\n]*?)\*(?=$|[\s.,;:!?)])/gm,
    (_m, pre: string, body: string) => `${pre}${hold(`<i>${escapeHtml(body)}</i>`)}`,
  );
  text = text.replace(
    /(^|[\s(])_(\S[^_\n]*?)_(?=$|[\s.,;:!?)])/gm,
    (_m, pre: string, body: string) => `${pre}${hold(`<i>${escapeHtml(body)}</i>`)}`,
  );

  // 6. Everything still unconverted is literal text.
  text = escapeHtml(text);

  // 7. Restore the converted spans.
  return text.replace(
    new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g"),
    (_m, i: string) => held[Number(i)] ?? "",
  );
}
