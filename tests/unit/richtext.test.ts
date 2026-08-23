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

  test("bullet lists become real bullets", () => {
    // Telegram renders no list markup, so "- " arrived literal. A bullet
    // glyph is the closest thing that reads as a list.
    expect(markdownToTelegramHtml("- one\n- two")).toBe("\u2022 one\n\u2022 two");
    expect(markdownToTelegramHtml("* one\n+ two")).toBe("\u2022 one\n\u2022 two");
  });

  test("bold inside a list item still converts", () => {
    expect(markdownToTelegramHtml("- **a**: b")).toBe("\u2022 <b>a</b>: b");
  });

  test("indented bullets keep their indent", () => {
    expect(markdownToTelegramHtml("- a\n  - b")).toBe("\u2022 a\n  \u2022 b");
  });

  test("numbered lists are left alone", () => {
    // "1. x" already reads correctly; rewriting it would only risk mangling
    // prose that happens to start with a number.
    expect(markdownToTelegramHtml("1. one\n2. two")).toBe("1. one\n2. two");
  });

  // --- headings -------------------------------------------------------
  //
  // Telegram has no heading construct in EITHER parse mode. Bold is the
  // whole available answer, and "### Draft reply" reaching a user literally
  // is what prompted this.

  test("headings become bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
    expect(markdownToTelegramHtml("###### Deep")).toBe("<b>Deep</b>");
  });

  test("a heading already containing bold does not nest tags", () => {
    // Nested <b><b> is legal but "**" inside a heading is common enough
    // that leaving a stray marker would be visible.
    expect(markdownToTelegramHtml("## **Loud**")).toBe("<b>Loud</b>");
  });

  test("a hash that is not a heading is left alone", () => {
    expect(markdownToTelegramHtml("issue #42 is open")).toBe("issue #42 is open");
    expect(markdownToTelegramHtml("#hashtag")).toBe("#hashtag");
  });

  // --- separators -----------------------------------------------------

  test("horizontal rules become a visible line", () => {
    expect(markdownToTelegramHtml("a\n\n---\n\nb")).toContain("\u2500");
    expect(markdownToTelegramHtml("a\n\n***\n\nb")).toContain("\u2500");
    expect(markdownToTelegramHtml("a\n\n___\n\nb")).toContain("\u2500");
  });

  test("a rule does not eat an emphasis marker mid-sentence", () => {
    expect(markdownToTelegramHtml("cost me $3 --- worth it")).toBe(
      "cost me $3 --- worth it",
    );
  });

  // --- other inline constructs ----------------------------------------

  test("strikethrough converts", () => {
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("blockquotes convert", () => {
    expect(markdownToTelegramHtml("> quoted")).toBe("<blockquote>quoted</blockquote>");
  });

  test("a multi-line blockquote becomes one block", () => {
    expect(markdownToTelegramHtml("> one\n> two")).toBe(
      "<blockquote>one\ntwo</blockquote>",
    );
  });

  test("bold spanning a newline converts", () => {
    // The old regex was [^*\n]+, so a bold run wrapped by the model across
    // two lines stayed literal — one source of "asterisks everywhere".
    expect(markdownToTelegramHtml("**two\nlines**")).toBe("<b>two\nlines</b>");
  });

  test("a heading inside a fenced block is NOT converted", () => {
    expect(markdownToTelegramHtml("```\n# not a heading\n```")).toBe(
      "<pre># not a heading</pre>",
    );
  });

  test("the leaked draft narration renders with no stray markers", () => {
    // Regression fixture: this shape reached a user with visible "###" and
    // "***". Whatever else it does, nothing may pass through raw.
    const out = markdownToTelegramHtml(
      "Here is a draft:\n\n***\n\n### Draft reply\n\n**To:** a@b.com\n\nHi,\n\nBest",
    );
    expect(out).not.toContain("###");
    expect(out).not.toContain("***");
    expect(out).toContain("<b>Draft reply</b>");
  });
});
