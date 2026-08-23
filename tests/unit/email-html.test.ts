import { describe, expect, test } from "bun:test";
import { markdownToEmailHtml } from "../../convex/lib/email/markdownToEmailHtml";

describe("markdownToEmailHtml", () => {
  test("paragraphs become <p>", () => {
    expect(markdownToEmailHtml("one\n\ntwo")).toBe("<p>one</p>\n<p>two</p>");
  });

  test("a single newline inside a paragraph becomes <br>", () => {
    // "Best,\nAde" is a sign-off, not two paragraphs.
    expect(markdownToEmailHtml("Best,\nAde")).toBe("<p>Best,<br>Ade</p>");
  });

  test("bold and italic convert", () => {
    expect(markdownToEmailHtml("**b** and *i*")).toBe(
      "<p><strong>b</strong> and <em>i</em></p>",
    );
  });

  test("links convert and their href is escaped", () => {
    expect(markdownToEmailHtml("[x](https://a.com/?a=1&b=2)")).toBe(
      '<p><a href="https://a.com/?a=1&amp;b=2">x</a></p>',
    );
  });

  test("bullet lists become a real <ul>", () => {
    expect(markdownToEmailHtml("- one\n- two")).toBe(
      "<ul>\n<li>one</li>\n<li>two</li>\n</ul>",
    );
  });

  test("numbered lists become <ol>", () => {
    expect(markdownToEmailHtml("1. one\n2. two")).toBe(
      "<ol>\n<li>one</li>\n<li>two</li>\n</ol>",
    );
  });

  test("HTML metacharacters in the source are escaped, never interpreted", () => {
    // A body quoting <script> must arrive as text in the recipient's client.
    expect(markdownToEmailHtml("a <script>alert(1)</script> b")).toBe(
      "<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>",
    );
  });

  test("an ampersand is escaped exactly once", () => {
    expect(markdownToEmailHtml("Tom & Jerry")).toBe("<p>Tom &amp; Jerry</p>");
  });

  test("a javascript: URL is not linkified", () => {
    // Only http(s) is linkified; anything else stays literal text.
    const out = markdownToEmailHtml("[click](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).toContain("javascript:alert(1)");
  });

  test("an empty body produces an empty document rather than a stray tag", () => {
    expect(markdownToEmailHtml("")).toBe("");
    expect(markdownToEmailHtml("   \n\n  ")).toBe("");
  });

  test("a realistic reply renders end to end", () => {
    const body = "Hi Ade,\n\nTwo things:\n\n- the **deadline** moved\n- I sent the file\n\nBest,\nAde";
    const out = markdownToEmailHtml(body);
    expect(out).toContain("<p>Hi Ade,</p>");
    expect(out).toContain("<strong>deadline</strong>");
    expect(out).toContain("<li>I sent the file</li>");
    expect(out).toContain("<p>Best,<br>Ade</p>");
  });
});
