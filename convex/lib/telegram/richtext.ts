// Pure. No ctx, no fetch.
//
// The model writes ordinary Markdown. Telegram renders none of it unless a
// parse_mode is set, and it has no heading, list or rule construct in EITHER
// parse mode — so "### Draft reply", "---" and "- item" all reached users
// literally, and "***" was even worse: the italic rule ate it and emitted
// "<i>*</i>".
//
// This converts Markdown to Telegram's HTML parse_mode rather than MarkdownV2,
// deliberately: HTML needs exactly three characters escaped (& < >), where
// MarkdownV2 needs eighteen and has already caused two production 400s in this
// project. Fewer escape rules is fewer ways to be wrong on a path that every
// outbound message goes through.

/** Telegram's HTML mode understands only b, i, u, s, code, pre, blockquote
 *  and a. Everything else is literal text, so only these three need escaping. */
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

/** Telegram has no <hr>. A box-drawing run is the nearest readable thing. */
const RULE = "──────────";

/**
 * Markdown -> Telegram HTML.
 *
 * Order matters and is load-bearing:
 *   1. fenced code, so its contents are never re-parsed as markdown
 *   2. inline code, same reason
 *   3. links, before emphasis so a URL's underscores are not italicised
 *   4. LINE-level rules (rules, headings, bullets) before INLINE ones, so a
 *      "***" line is a separator rather than three emphasis markers
 *   5. emphasis
 *   6. blockquote tags parked, body left for escaping
 *   7. escape whatever text remains, then restore the parked spans
 *
 * An unmatched marker is left as literal text. Telegram rejects the WHOLE
 * message with a 400 on an unbalanced tag, so "2 * 3 = 6" must never open
 * an <i>.
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

  // 4a. Horizontal rules — a whole line of ***, --- or ___. This MUST precede
  //     the emphasis rules; before it existed, "***" matched the italic rule.
  text = text.replace(/^[ \t]*(?:\*{3,}|-{3,}|_{3,})[ \t]*$/gm, () => hold(RULE));

  // 4b. Headings. Telegram has no heading construct, so a heading becomes
  //     bold — rewritten AS markdown bold and left for rule 5, which keeps
  //     one code path for "make this bold" and avoids nesting <b> inside <b>
  //     when the heading was already written as "## **Loud**".
  text = text.replace(
    /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm,
    (_m, content: string) => `**${stripEmphasisMarkers(content)}**`,
  );

  // 5. Bold before italic — otherwise ** is consumed as two single markers.
  //    [^*]+? rather than [^*\n]+ so a bold run the model wrapped across two
  //    lines still converts; that was one source of visible asterisks.
  text = text.replace(/\*\*([^*]+?)\*\*/g, (_m, body: string) =>
    hold(`<b>${escapeHtml(body)}</b>`),
  );
  text = text.replace(/__([^_]+?)__/g, (_m, body: string) =>
    hold(`<b>${escapeHtml(body)}</b>`),
  );

  // 5b. Strikethrough.
  text = text.replace(/~~([^~\n]+)~~/g, (_m, body: string) =>
    hold(`<s>${escapeHtml(body)}</s>`),
  );

  // 5c. Italic. Requires a non-space immediately inside the markers, so
  //     arithmetic ("2 * 3 = 6") and bare list bullets are left alone.
  text = text.replace(
    /(^|[\s(])\*(\S[^*\n]*?)\*(?=$|[\s.,;:!?)])/gm,
    (_m, pre: string, body: string) => `${pre}${hold(`<i>${escapeHtml(body)}</i>`)}`,
  );
  text = text.replace(
    /(^|[\s(])_(\S[^_\n]*?)_(?=$|[\s.,;:!?)])/gm,
    (_m, pre: string, body: string) => `${pre}${hold(`<i>${escapeHtml(body)}</i>`)}`,
  );

  // 6. Bullets. After emphasis, so "* one" was never a candidate for italic.
  //    Ordered lists are left alone — "1. x" already reads correctly, and
  //    rewriting it would risk mangling prose that opens with a number.
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, (_m, indent: string) => `${indent}• `);

  // 7. Blockquotes. Consecutive "> " lines become ONE block. Only the TAGS
  //    are parked — the quoted body stays in the text so step 8 escapes it,
  //    which is what keeps a quoted email safe here.
  text = text.replace(/(?:^[ \t]*>[ \t]?.*(?:\n|$))+/gm, (block: string) => {
    const inner = block
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.replace(/^[ \t]*>[ \t]?/, ""))
      .join("\n");
    return `${hold("<blockquote>")}${inner}${hold("</blockquote>")}`;
  });

  // 8. Everything still unconverted is literal text.
  text = escapeHtml(text);

  // 9. Restore the converted spans.
  return text.replace(
    new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g"),
    (_m, i: string) => held[Number(i)] ?? "",
  );
}

/** "**Loud**" -> "Loud". Heading text is frequently written already-bold;
 *  re-wrapping it would nest tags or strand a marker. */
function stripEmphasisMarkers(text: string): string {
  return text.replace(/^\s*(?:\*\*|__)([\s\S]*?)(?:\*\*|__)\s*$/, "$1").trim();
}
