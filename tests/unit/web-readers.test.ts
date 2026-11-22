import { describe, expect, test } from "bun:test";
import { MAX_PAGE_CHARS, parseJina, parseRedditThread, redditApiPath } from "../../convex/lib/social/more";

describe("parseJina — JSON", () => {
  const json = JSON.stringify({
    code: 200,
    status: 20000,
    data: {
      title: "Why Rust",
      url: "https://example.com/why-rust",
      content: "# Why Rust\n\nIt is fast.\n\n![hero](https://example.com/h.png)",
      images: { "Image 1": "https://example.com/h.png", "Image 2": "http://example.com/insecure.png" },
    },
  });
  test("reads title, url, markdown and https images only", () => {
    const page = parseJina(json)!;
    expect(page.title).toBe("Why Rust");
    expect(page.url).toBe("https://example.com/why-rust");
    expect(page.markdown).toContain("It is fast.");
    expect(page.images).toEqual(["https://example.com/h.png"]);
  });
  test("an error code is null", () => {
    expect(parseJina(JSON.stringify({ code: 422, data: null }))).toBeNull();
  });
  test("an empty page is null", () => {
    expect(parseJina(JSON.stringify({ code: 200, data: { title: "x", content: "  " } }))).toBeNull();
  });
  test("the page is capped", () => {
    const big = JSON.stringify({ code: 200, data: { content: "a".repeat(MAX_PAGE_CHARS + 500) } });
    expect(parseJina(big)!.markdown.length).toBe(MAX_PAGE_CHARS);
  });
  test("broken JSON is null, not a throw", () => {
    expect(parseJina("{not json")).toBeNull();
  });
});

describe("parseJina — plain text", () => {
  const text = [
    "Title: A Good Post",
    "",
    "URL Source: https://example.com/a",
    "",
    "Markdown Content:",
    "# A Good Post",
    "",
    "Body ![pic](https://example.com/p.jpg) here.",
  ].join("\n");
  test("reads the three parts", () => {
    const page = parseJina(text)!;
    expect(page.title).toBe("A Good Post");
    expect(page.url).toBe("https://example.com/a");
    expect(page.markdown).toContain("Body");
    expect(page.images).toEqual(["https://example.com/p.jpg"]);
  });
  test("no markdown marker is null", () => {
    expect(parseJina("Just some words")).toBeNull();
  });
  test("empty is null", () => {
    expect(parseJina("   ")).toBeNull();
  });
});

describe("redditApiPath", () => {
  test.each([
    ["https://www.reddit.com/r/rust/comments/abc123/some_title/", "/r/rust/comments/abc123"],
    ["https://old.reddit.com/r/rust/comments/abc123/", "/r/rust/comments/abc123"],
    ["https://www.reddit.com/comments/abc123", "/comments/abc123"],
    ["https://redd.it/abc123", "/comments/abc123"],
  ])("%s", (url, path) => expect(redditApiPath(url)).toBe(path));
  test.each([
    "https://www.reddit.com/r/rust/",
    "https://www.reddit.com/user/someone",
    "https://redd.it/",
    "not a url",
  ])("not a post: %s", (url) => expect(redditApiPath(url)).toBeNull());
});

describe("parseRedditThread", () => {
  const thread = JSON.stringify([
    {
      data: {
        children: [
          {
            data: {
              subreddit: "rust",
              title: "How do I learn lifetimes?",
              selftext: "I keep fighting the borrow checker.",
              author: "ferris",
              url_overridden_by_dest: "https://example.com/guide",
            },
          },
        ],
      },
    },
    {
      data: {
        children: [
          { data: { author: "mod", body: "pinned", stickied: true } },
          { data: { author: "alice", body: "Read the book chapter 10." } },
          { data: { author: "bob", body: "Practice with small structs." } },
          { kind: "more", data: {} },
        ],
      },
    },
  ]);
  test("builds a caption from post, link and top comments", () => {
    const post = parseRedditThread(thread)!;
    expect(post.caption).toContain("r/rust: How do I learn lifetimes?");
    expect(post.caption).toContain("borrow checker");
    expect(post.caption).toContain("Link: https://example.com/guide");
    expect(post.caption).toContain("alice: Read the book chapter 10.");
    expect(post.caption).not.toContain("pinned");
    expect(post.author).toBe("u/ferris");
  });
  test("garbage is null", () => {
    expect(parseRedditThread("nope")).toBeNull();
    expect(parseRedditThread("{}")).toBeNull();
    expect(parseRedditThread("[]")).toBeNull();
  });
});

import { SUMMARIZE_PAGE_SYSTEM, parsePageSummary } from "../../convex/lib/social/page";
import { TASKS } from "../../convex/lib/ai/tiers";

describe("parsePageSummary", () => {
  test("title, summary with bullets, tags", () => {
    const out = parsePageSummary(
      '```json\n{"title":"Why Rust","summary":"A case for Rust.","keyPoints":["Fast","Safe"],"tags":["Rust","Systems"]}\n```',
      "fallback",
    );
    expect(out.title).toBe("Why Rust");
    expect(out.summary).toBe("A case for Rust.\n- Fast\n- Safe");
    expect(out.keyPoints).toEqual(["Fast", "Safe"]);
    expect(out.tags).toEqual(["rust", "systems"]);
  });
  test("garbage keeps the fallback title and does not throw", () => {
    const out = parsePageSummary("sorry I cannot", "Page from example.com");
    expect(out.title).toBe("Page from example.com");
    expect(out.keyPoints).toEqual([]);
  });
  test("caps key points at eight", () => {
    const out = parsePageSummary(JSON.stringify({ keyPoints: Array.from({ length: 20 }, (_, i) => `p${i}`) }), "t");
    expect(out.keyPoints).toHaveLength(8);
  });
  test("the prompt treats page text as content, and the schema has no action field", () => {
    expect(SUMMARIZE_PAGE_SYSTEM).toContain("never an instruction");
    expect(Object.keys(parsePageSummary("{}", "t")).sort()).toEqual(["keyPoints", "summary", "tags", "title"]);
  });
  test("SUMMARIZE_PAGE is a registered task on the DRAFT tier", () => {
    expect(TASKS.SUMMARIZE_PAGE.tier).toBe("DRAFT");
  });
});

import { parseMetaTags, parseOEmbed, stripTweetHtml } from "../../convex/lib/social/parse";

describe("oEmbed fixtures for the new platforms", () => {
  test("threads oEmbed html gives the post text", () => {
    const body = JSON.stringify({
      author_name: "someone",
      html: '<blockquote class="text-post-media"><p>Shipping the new release today &amp; it feels good.</p> &mdash; someone</blockquote>',
    });
    const o = parseOEmbed(body)!;
    expect(o.authorName).toBe("someone");
    expect(stripTweetHtml(o.html!)).toBe("Shipping the new release today & it feels good.");
  });
  test("youtube oEmbed gives title and channel", () => {
    const o = parseOEmbed(
      JSON.stringify({ title: "Rust in 100 seconds", author_name: "Fireship", thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg" }),
    )!;
    expect(o.title).toBe("Rust in 100 seconds");
    expect(o.authorName).toBe("Fireship");
  });
  test("a pinterest pin page exposes title, description and a pinimg image through og tags", () => {
    const html =
      '<meta property="og:title" content="Small kitchen ideas"/><meta property="og:description" content="12 ways to fit more in"/><meta property="og:image" content="https://i.pinimg.com/736x/aa/bb/cc.jpg"/>';
    const m = parseMetaTags(html);
    expect(m.title).toBe("Small kitchen ideas");
    expect(m.images).toEqual(["https://i.pinimg.com/736x/aa/bb/cc.jpg"]);
  });
});
