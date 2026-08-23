import { describe, expect, test } from "bun:test";
import { parseMetaTags, parseOEmbed, stripTweetHtml } from "../../convex/lib/social/parse";

describe("parseMetaTags", () => {
  test("reads og:title, og:description and og:image", () => {
    const html = `<html><head>
      <meta property="og:title" content="A post title" />
      <meta property="og:description" content="The caption goes here" />
      <meta property="og:image" content="https://cdn.example/1.jpg" />
    </head></html>`;
    expect(parseMetaTags(html)).toEqual({
      title: "A post title",
      description: "The caption goes here",
      images: ["https://cdn.example/1.jpg"],
    });
  });

  test("handles attributes in the other order and single quotes", () => {
    const html = `<meta content='Caption' property='og:description'>`;
    expect(parseMetaTags(html).description).toBe("Caption");
  });

  test("falls back to name= when property= is absent", () => {
    // Twitter cards use name="twitter:description".
    const html = `<meta name="twitter:description" content="Tweet text">`;
    expect(parseMetaTags(html).description).toBe("Tweet text");
  });

  test("decodes HTML entities in the caption", () => {
    const html = `<meta property="og:description" content="Tom &amp; Jerry &#39;s &quot;day&quot;">`;
    expect(parseMetaTags(html).description).toBe(`Tom & Jerry 's "day"`);
  });

  test("decodes hex entities, which Instagram uses for dashes and emoji", () => {
    const html = `<meta property="og:description" content="a field&#x2014;or a friend &#x1F42E;">`;
    expect(parseMetaTags(html).description).toBe("a field—or a friend 🐮");
  });

  test("collects every og:image, for a carousel", () => {
    const html = `
      <meta property="og:image" content="https://cdn.example/1.jpg">
      <meta property="og:image" content="https://cdn.example/2.jpg">`;
    expect(parseMetaTags(html).images).toHaveLength(2);
  });

  test("ignores a non-https image URL", () => {
    const html = `<meta property="og:image" content="http://cdn.example/1.jpg">`;
    expect(parseMetaTags(html).images).toEqual([]);
  });

  test("returns empty fields rather than throwing on junk", () => {
    expect(parseMetaTags("")).toEqual({ images: [] });
    expect(parseMetaTags("<html>no meta at all</html>").title).toBeUndefined();
  });

  test("a script tag masquerading as meta does not leak through", () => {
    // The page is attacker-influenced content; nothing from it is markup here.
    const html = `<script>var x = '<meta property="og:title" content="evil">'</script>`;
    expect(parseMetaTags(html).title).toBeUndefined();
  });
});

describe("parseOEmbed", () => {
  test("reads title, author and html from a TikTok-shaped response", () => {
    const json = JSON.stringify({
      title: "the caption",
      author_name: "someone",
      thumbnail_url: "https://cdn.example/t.jpg",
      html: "<blockquote>x</blockquote>",
    });
    const out = parseOEmbed(json);
    expect(out?.title).toBe("the caption");
    expect(out?.authorName).toBe("someone");
    expect(out?.thumbnailUrl).toBe("https://cdn.example/t.jpg");
  });

  test("returns null on non-JSON rather than throwing", () => {
    expect(parseOEmbed("<html>error</html>")).toBeNull();
  });

  test("returns null on JSON that is not an object", () => {
    expect(parseOEmbed("[1,2,3]")).toBeNull();
  });
});

describe("stripTweetHtml", () => {
  test("recovers the tweet text from an oEmbed blockquote", () => {
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">' +
      'The actual tweet text &amp; more</p>&mdash; Name (@handle) ' +
      '<a href="https://twitter.com/x/status/1">August 1, 2026</a></blockquote>';
    const out = stripTweetHtml(html);
    expect(out).toContain("The actual tweet text & more");
    expect(out).not.toContain("<");
    expect(out).not.toContain("blockquote");
  });

  test("converts <br> to newlines so multi-line tweets keep their shape", () => {
    expect(stripTweetHtml("<p>one<br>two</p>")).toBe("one\ntwo");
  });

  test("empty input gives empty output", () => {
    expect(stripTweetHtml("")).toBe("");
  });
});
