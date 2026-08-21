import { describe, expect, test } from "bun:test";
import { markdownToTelegramHtml } from "../../convex/lib/telegram/richtext";

describe("markdownToTelegramHtml", () => {
  test("bold, italic and inline code become tags", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  test("fenced blocks become pre, with the language stripped", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1;\n```")).toBe(
      "<pre>const a = 1;</pre>",
    );
  });

  test("HTML metacharacters in the SOURCE are escaped, not interpreted", () => {
    // Without this, an email quoting <script> or a subject containing & would
    // either break the parse or inject markup.
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("code content is escaped inside its tags", () => {
    expect(markdownToTelegramHtml("`<div>`")).toBe("<code>&lt;div&gt;</code>");
  });

  test("markdown links become anchors", () => {
    expect(markdownToTelegramHtml("[text](https://x.com)")).toBe(
      '<a href="https://x.com">text</a>',
    );
  });

  test("plain text passes through untouched", () => {
    expect(markdownToTelegramHtml("just a sentence.")).toBe("just a sentence.");
  });

  test("an unmatched marker is left literal rather than producing a broken tag", () => {
    // A stray asterisk must not open a <b> that never closes — Telegram
    // rejects unbalanced tags with a 400 on the whole message.
    expect(markdownToTelegramHtml("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  test("bullet lists keep their bullets", () => {
    expect(markdownToTelegramHtml("- one\n- two")).toBe("- one\n- two");
  });

  test("bold inside a list item still converts", () => {
    expect(markdownToTelegramHtml("- **a**: b")).toBe("- <b>a</b>: b");
  });
});
