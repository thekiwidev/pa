import { describe, expect, test } from "bun:test";
import { TELEGRAM_MAX_LEN, splitTelegramHtml } from "../../convex/lib/telegram/split";
import { markdownToTelegramHtml } from "../../convex/lib/telegram/richtext";

const within = (parts: string[]) => parts.every((p) => p.length <= TELEGRAM_MAX_LEN);

/** Tags left open at the end of a chunk are what Telegram 400s on. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    const slash = m[1] ?? "";
    const tag = m[2] ?? "";
    if (slash) {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

describe("splitTelegramHtml", () => {
  test("short text is one part, unchanged", () => {
    expect(splitTelegramHtml("hello")).toEqual(["hello"]);
  });

  test("empty text yields no parts rather than one empty message", () => {
    expect(splitTelegramHtml("")).toEqual([]);
    expect(splitTelegramHtml("   \n  ")).toEqual([]);
  });

  test("text at exactly the limit stays whole", () => {
    const text = "a".repeat(TELEGRAM_MAX_LEN);
    expect(splitTelegramHtml(text)).toEqual([text]);
  });

  test("long text splits into parts that all fit", () => {
    const para = "x".repeat(500);
    const parts = splitTelegramHtml(Array(20).fill(para).join("\n\n"));
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts)).toBe(true);
  });

  test("splitting prefers paragraph boundaries", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    const parts = splitTelegramHtml(`${a}\n\n${b}`);
    expect(parts).toEqual([a, b]);
  });

  test("falls back to line boundaries when a paragraph is too big", () => {
    const line = "y".repeat(1000);
    const parts = splitTelegramHtml(Array(8).fill(line).join("\n"));
    expect(within(parts)).toBe(true);
    // No part may start or end mid-line when lines were an option.
    for (const p of parts) expect(p.split("\n").every((l) => l === line)).toBe(true);
  });

  test("a single unbreakable run is hard-split rather than dropped", () => {
    const parts = splitTelegramHtml("z".repeat(10000));
    expect(within(parts)).toBe(true);
    expect(parts.join("")).toBe("z".repeat(10000));
  });

  test("never splits in the middle of a tag", () => {
    const chunk = `${"w".repeat(4090)}\n<b>bold text here</b>`;
    for (const p of splitTelegramHtml(chunk)) {
      expect(p).not.toMatch(/<[a-z/]*$/);
      expect(p).not.toMatch(/^[a-z/]*>/);
    }
  });

  test("a tag spanning the boundary is closed and reopened", () => {
    // This is the case that produced live 400s: the old code sliced raw
    // markdown at 4096 and converted afterwards, so a cut inside "**" made
    // unbalanced HTML, Telegram rejected the message, and the retry path
    // re-sent it with NO parse_mode — every asterisk visible.
    const html = `<b>${"q".repeat(6000)}</b>`;
    const parts = splitTelegramHtml(html);
    expect(parts.length).toBeGreaterThan(1);
    expect(within(parts)).toBe(true);
    for (const p of parts) expect(balanced(p)).toBe(true);
    expect(parts[0]).toEndWith("</b>");
    expect(parts[1]).toStartWith("<b>");
  });

  test("nested tags across a boundary are closed innermost-first", () => {
    const html = `<blockquote><b>${"r".repeat(6000)}</b></blockquote>`;
    const parts = splitTelegramHtml(html);
    for (const p of parts) expect(balanced(p)).toBe(true);
  });

  test("an anchor's href survives being reopened", () => {
    const html = `<a href="https://x.com">${"s".repeat(6000)}</a>`;
    const parts = splitTelegramHtml(html);
    for (const p of parts) expect(balanced(p)).toBe(true);
    expect(parts[1]).toContain('href="https://x.com"');
  });

  test("a real long brief round-trips through convert-then-split intact", () => {
    const md = Array(60)
      .fill("## Section\n\nSome **bold** and a `code` bit.\n\n- one\n- two\n")
      .join("\n");
    const parts = splitTelegramHtml(markdownToTelegramHtml(md));
    expect(within(parts)).toBe(true);
    for (const p of parts) expect(balanced(p)).toBe(true);
    // No raw markdown may survive anywhere.
    for (const p of parts) expect(p).not.toContain("##");
  });

  test("escaped entities are never cut in half", () => {
    // "&amp;" split across a boundary would render as literal "&am".
    const html = "&amp;".repeat(2000);
    for (const p of splitTelegramHtml(html)) {
      expect(p).not.toMatch(/&[a-z]*$/);
    }
  });
});
