import { describe, expect, test } from "bun:test";
import { DEFAULT_SOURCES, buildRequest, senderMatches, sourceConfigured, sourceName, type SourceSpec } from "../../convex/lib/news/sources";
import { feedbackButtons, headlineOnly, parseNewsletter, renderNewsletter, WRITE_NEWSLETTER_SYSTEM } from "../../convex/lib/news/newsletter";
import { sameDomainLinks, webReadVerdict } from "../../convex/lib/news/webread";
import { parseReddit } from "../../convex/lib/news/normalize";

describe("sources", () => {
  test("a source needing a key is skipped without it", () => {
    expect(sourceConfigured("dailydev", {})).toBe(false);
    expect(sourceConfigured("dailydev", { DAILYDEV_TOKEN: "x" })).toBe(true);
    expect(sourceConfigured("reddit", { REDDIT_CLIENT_ID: "a" })).toBe(false);
    expect(sourceConfigured("reddit", { REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b" })).toBe(true);
    expect(sourceConfigured("hn", {})).toBe(true);
  });
  test("keyless defaults give at least five sources", () => {
    expect(DEFAULT_SOURCES.filter((s) => sourceConfigured(s.kind, {})).length).toBeGreaterThanOrEqual(5);
  });
  test("every default builds a request or is handled outside buildRequest", () => {
    for (const s of DEFAULT_SOURCES) {
      const req = buildRequest(s, { DAILYDEV_TOKEN: "t" });
      if (s.kind === "reddit") expect(req).toBeNull();
      else expect(req?.url).toMatch(/^https:\/\//);
    }
  });
  test("a topic narrows hn and gnews", () => {
    expect(buildRequest({ kind: "hn", config: {} }, {}, "ai agents")!.url).toContain("query=ai%20agents");
    expect(buildRequest({ kind: "gnews", config: {} }, {}, "rust")!.url).toContain("rust");
  });
  test("the daily.dev token goes in a header, never the url", () => {
    const req = buildRequest({ kind: "dailydev", config: {} }, { DAILYDEV_TOKEN: "secret" })!;
    expect(req.url).not.toContain("secret");
    expect(req.headers.Authorization).toBe("Bearer secret");
  });
  test("stack exchange key is optional", () => {
    expect(buildRequest({ kind: "stackexchange", config: {} }, {})!.url).not.toContain("key=");
    expect(buildRequest({ kind: "stackexchange", config: {} }, { STACKEXCHANGE_KEY: "k" })!.url).toContain("key=k");
  });
  test("an rss source without a url builds nothing", () => {
    expect(buildRequest({ kind: "rss", config: {} }, {})).toBeNull();
  });
  test("names", () => {
    const rss: SourceSpec = { kind: "rss", config: { url: "https://blog.example/feed" } };
    expect(sourceName(rss)).toBe("blog.example");
    expect(sourceName({ kind: "hn", config: {} })).toBe("Hacker News");
  });
  test("newsletter sender patterns", () => {
    expect(senderMatches("@tldrnewsletter.com", "dan@TLDRnewsletter.com")).toBe(true);
    expect(senderMatches("dan@x.com", "dan@x.com")).toBe(true);
    expect(senderMatches("dan@x.com", "evil-dan@x.com")).toBe(false);
    expect(senderMatches("@x.com", "a@notx.com.evil.io")).toBe(false);
    expect(senderMatches("", "a@b.c")).toBe(false);
  });
});

describe("parseReddit", () => {
  test("link posts use the target, self posts the thread, stickies are dropped", () => {
    const body = JSON.stringify({ data: { children: [
      { data: { title: "Link", url: "https://a.example/x", score: 5, created_utc: 1_700_000_000, permalink: "/r/p/1/" } },
      { data: { title: "Self", url: "https://www.reddit.com/r/p/2/", score: 3, selftext: "body", permalink: "/r/p/2/" } },
      { data: { title: "Pinned", stickied: true, url: "https://a.example/y", permalink: "/r/p/3/" } },
    ] } });
    const out = parseReddit(body, "programming");
    expect(out.map((o) => o.title)).toEqual(["Link", "Self"]);
    expect(out[1]!.url).toBe("https://www.reddit.com/r/p/2/");
    expect(out[0]!.source).toBe("r/programming");
  });
});

describe("newsletter", () => {
  const allowed = [
    { url: "https://a.example/1", title: "One", source: "HN" },
    { url: "https://b.example/2", title: "Two", source: "DEV" },
  ];
  test("a url the model invented is dropped, a copied one is kept", () => {
    const raw = JSON.stringify({ items: [
      { url: "https://evil.example/phish", title: "Click me", keyPoints: ["x"], whyItMatters: "y" },
      { url: "https://a.example/1?utm_source=z", title: "Better title", keyPoints: ["fact", "fact 2"], whyItMatters: "because" },
    ] });
    const out = parseNewsletter(raw, allowed);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ url: "https://a.example/1", title: "Better title", source: "HN" });
  });
  test("tolerates prose around the json, caps points, ignores duplicates", () => {
    const raw = `Here you go:\n${JSON.stringify({ items: [
      { url: "https://a.example/1", keyPoints: ["1", "2", "3", "4", "5"] },
      { url: "https://a.example/1", keyPoints: ["dup"] },
    ] })}`;
    const out = parseNewsletter(raw, allowed);
    expect(out.length).toBe(1);
    expect(out[0]!.keyPoints.length).toBe(3);
    expect(out[0]!.title).toBe("One");
  });
  test("garbage is an empty list and the fallback is headlines", () => {
    expect(parseNewsletter("nope", allowed)).toEqual([]);
    expect(parseNewsletter("{\"items\": 4}", allowed)).toEqual([]);
    expect(headlineOnly(allowed).map((i) => i.title)).toEqual(["One", "Two"]);
  });
  test("the output schema has no action-shaped field", () => {
    expect(WRITE_NEWSLETTER_SYSTEM).toContain("untrusted");
    expect(WRITE_NEWSLETTER_SYSTEM).not.toMatch(/"(tool|action|send|command)"/i);
  });
  test("rendering escapes html in titles and points", () => {
    const html = renderNewsletter([{ title: "<script>x</script> & co", url: "https://a.example/1?a=1&b=2", source: "HN", keyPoints: ["a < b"], whyItMatters: "" }], "Tech <today>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Tech &lt;today&gt;");
    expect(html).toContain("a &lt; b");
  });
  test("feedback buttons: one pair per item, data carries the id", () => {
    const rows = feedbackButtons(["id1", "id2"], { up: "newsup", down: "newsdown" });
    expect(rows.length).toBe(2);
    expect(rows[1]![0]).toEqual({ text: "👍 2", data: "newsup:id2" });
    expect(rows[1]![1]).toEqual({ text: "👎 2", data: "newsdown:id2" });
  });
});

describe("web.read guard", () => {
  const owner = ["https://blog.example.com/posts/hello"];
  test("the url the owner sent is allowed, tracking params aside", () => {
    expect(webReadVerdict("https://blog.example.com/posts/hello?utm_source=x", owner)).toBe("owner");
  });
  test("another page of the same registrable domain is a follow", () => {
    expect(webReadVerdict("https://www.example.com/about", owner)).toBe("same-domain");
    expect(webReadVerdict("https://docs.example.com/x", owner)).toBe("same-domain");
  });
  test("a different domain is refused, including look-alikes and non-https", () => {
    expect(webReadVerdict("https://evil.com/collect?d=secret", owner)).toBeNull();
    expect(webReadVerdict("https://example.com.evil.com/x", owner)).toBeNull();
    expect(webReadVerdict("http://blog.example.com/x", owner)).toBeNull();
    expect(webReadVerdict("https://blog.example.com/x", [])).toBeNull();
  });
  test("only same-domain https links are offered, once each, never the page itself", () => {
    const md = "[Home](https://example.com/) [Self](https://blog.example.com/posts/hello) [Next](https://example.com/next) [Dup](https://example.com/next?utm_source=a) [Out](https://other.com/x) [Http](http://example.com/y)";
    const out = sameDomainLinks(md, "https://blog.example.com/posts/hello");
    expect(out.map((l) => l.url)).toEqual(["https://example.com/", "https://example.com/next"]);
  });
});
