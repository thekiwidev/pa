// Pure. Markdown -> HTML for the text/html part of an outgoing email.
//
// Deliberately NOT lib/telegram/richtext.ts. The two targets differ in every
// way that matters: mail clients want block structure (<p>, <ul>, <li>) where
// Telegram has none and wants bare newlines; mail clients want <strong>/<em>
// where Telegram wants <b>/<i>; Telegram caps a message at 4096 and this has
// no cap. Sharing one converter would mean one of them getting the wrong
// output, so they are separate on purpose.
//
// Why this exists at all: until 2026-08-23 outgoing mail was single-part
// text/plain with the body concatenated raw, so a reply containing "**bold**"
// arrived with the asterisks visible.

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Inline spans, applied to already-escaped text. */
function inline(escaped: string): string {
  return (
    escaped
      // Links first, so a URL's underscores are never italicised. Only
      // http(s) — a javascript: or data: URL must stay literal text.
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, label: string, href: string) => `<a href="${href}">${label}</a>`,
      )
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_(\S[^_\n]*?)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>")
  );
}

const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/**
 * Convert a reply body to email HTML.
 *
 * Block structure is derived from blank lines, exactly as a writer expects: a
 * blank line starts a new paragraph, a single newline inside one is a line
 * break (so "Best,\nAde" is one paragraph, not two).
 */
export function markdownToEmailHtml(markdown: string): string {
  if (markdown.trim().length === 0) return "";

  const blocks = markdown.trim().split(/\n[ \t]*\n/);
  const out: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    if (lines.every((l) => BULLET.test(l))) {
      out.push(renderList("ul", lines, BULLET));
      continue;
    }
    if (lines.every((l) => NUMBERED.test(l))) {
      out.push(renderList("ol", lines, NUMBERED));
      continue;
    }

    const body = lines.map((l) => inline(escapeHtml(l.trim()))).join("<br>");
    out.push(`<p>${body}</p>`);
  }

  return out.join("\n");
}

function renderList(tag: "ul" | "ol", lines: string[], pattern: RegExp): string {
  const items = lines
    .map((l) => `<li>${inline(escapeHtml(pattern.exec(l)?.[1]?.trim() ?? ""))}</li>`)
    .join("\n");
  return `<${tag}>\n${items}\n</${tag}>`;
}
