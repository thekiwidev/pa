// Pure. Markdown <-> Notion blocks.
//
// Notion has no markdown field: a page's body is an array of typed block
// objects. So writing a note means translating, and reading one back means
// translating again — and the return trip has to survive block types a HUMAN
// created in the Notion UI, which is most of them.
//
// Everything read back out of Notion is UNTRUSTED. It reaches a prompt through
// AIRequest.untrusted like any email body.

/** Notion rejects a rich_text content string over 2000 characters. */
export const RICH_TEXT_LIMIT = 2000;

/** Languages Notion accepts. An unknown one fails the whole request, so
 *  anything not on this list falls back rather than being sent through. */
const CODE_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  json: "json",
  py: "python",
  python: "python",
  sh: "shell",
  bash: "bash",
  shell: "shell",
  sql: "sql",
  html: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
};

const LINK = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Bare URLs become real links. Notion's API does not autolink, so a source
 * URL pasted as plain text in a note could not be clicked.
 */
function richText(content: string): unknown[] {
  const parts: unknown[] = [];
  let last = 0;
  for (const m of content.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: "text", text: { content: content.slice(last, at) } });
    parts.push({ type: "text", text: { content: m[0], link: { url: m[0] } } });
    last = at + m[0].length;
  }
  if (last < content.length || parts.length === 0) parts.push({ type: "text", text: { content: content.slice(last) } });
  return parts;
}

/**
 * Split a line at the rich-text limit.
 *
 * Splitting rather than truncating is deliberate: a note whose tail vanished
 * looks complete, and the user has no way to know what was lost.
 */
function chunk(text: string): string[] {
  if (text.length <= RICH_TEXT_LIMIT) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    out.push(text.slice(i, i + RICH_TEXT_LIMIT));
  }
  return out;
}

function block(type: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return { object: "block", type, [type]: { rich_text: richText(text), ...extra } };
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const TODO = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/;
const FENCE = /^```([a-zA-Z0-9_+-]*)\s*$/;

/**
 * Markdown -> Notion blocks.
 *
 * Line-based, because Notion's model is line-based: every block below except
 * `code` corresponds to exactly one source line.
 */
export function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Fenced code first — its contents must not be parsed as markdown.
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? "").trim())) {
        body.push(lines[i] ?? "");
        i++;
      }
      const language = CODE_LANGUAGES[(fence[1] ?? "").toLowerCase()] ?? "plain text";
      for (const part of chunk(body.join("\n"))) {
        blocks.push(block("code", part, { language }));
      }
      continue;
    }

    if (line.trim().length === 0) continue;
    if (RULE.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Notion has exactly three levels; deeper headings clamp rather than
      // being dropped, which would lose the line entirely.
      const level = Math.min((heading[1] ?? "#").length, 3);
      for (const part of chunk(heading[2] ?? "")) {
        blocks.push(block(`heading_${level}`, part));
      }
      continue;
    }

    const todo = TODO.exec(line);
    if (todo) {
      const checked = (todo[1] ?? " ").toLowerCase() === "x";
      for (const part of chunk(todo[2] ?? "")) blocks.push(block("to_do", part, { checked }));
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      for (const part of chunk(bullet[1] ?? "")) blocks.push(block("bulleted_list_item", part));
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      for (const part of chunk(numbered[1] ?? "")) blocks.push(block("numbered_list_item", part));
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      for (const part of chunk(quote[1] ?? "")) blocks.push(block("quote", part));
      continue;
    }

    for (const part of chunk(line)) blocks.push(block("paragraph", part));
  }

  return blocks;
}

const PREFIX: Record<string, string> = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "1. ",
  quote: "> ",
  paragraph: "",
  code: "",
};

/**
 * Notion blocks -> markdown.
 *
 * Tolerant by necessity: a page the user edits in Notion will contain block
 * types this never writes (tables, embeds, child databases, columns). An
 * unknown type is skipped rather than throwing, because failing to read a
 * whole note over one embedded video would be absurd.
 */
export function blocksToMarkdown(blocks: unknown[]): string {
  const lines: string[] = [];

  for (const raw of blocks) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : "";

    if (type === "divider") {
      lines.push("---");
      continue;
    }

    const payload = b[type];
    if (typeof payload !== "object" || payload === null) continue;

    const richTextValue = (payload as Record<string, unknown>).rich_text;
    if (!Array.isArray(richTextValue)) continue;

    const text = richTextValue
      .map((r) => {
        if (typeof r !== "object" || r === null) return "";
        const entry = r as Record<string, unknown>;
        if (typeof entry.plain_text === "string") return entry.plain_text;
        const t = entry.text as { content?: unknown } | undefined;
        return typeof t?.content === "string" ? t.content : "";
      })
      .join("");

    if (type === "to_do") {
      const checked = (payload as { checked?: unknown }).checked === true;
      lines.push(`- [${checked ? "x" : " "}] ${text}`);
      continue;
    }

    const prefix = PREFIX[type];
    if (prefix === undefined) continue; // a type we do not render
    lines.push(`${prefix}${text}`);
  }

  return lines.join("\n");
}
