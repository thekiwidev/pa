import { describe, expect, test } from "bun:test";
import {
  dedupeCandidates,
  discoverFeedUrl,
  parseDailyDev,
  parseDevto,
  parseHn,
  parseLobsters,
  parseRss,
  parseStackExchange,
  urlHash,
  urlKey,
} from "../../convex/lib/news/normalize";

describe("urlKey / urlHash", () => {
  test("ignores tracking params, fragment, www, trailing slash and case of host", () => {
    const a = urlKey("https://www.Example.com/post/?utm_source=x&id=7#top");
    const b = urlKey("https://example.com/post?id=7");
    expect(a).toBe(b);
    expect(urlHash("https://www.Example.com/post/?utm_source=x&id=7#top")).toBe(urlHash("https://example.com/post?id=7"));
  });
  test("different articles hash differently", () => {
    expect(urlHash("https://example.com/a")).not.toBe(urlHash("https://example.com/b"));
  });
  test("a non-url comes back unchanged and hashes stably", () => {
    expect(urlKey("not a url")).toBe("not a url");
    expect(urlHash("not a url")).toBe(urlHash("not a url"));
  });
});

describe("parsers", () => {
  test("hn: algolia hits, falls back to the discussion link for self posts", () => {
    const body = JSON.stringify({
      hits: [
        { title: "Rust 2.0", url: "https://rust.example/2", points: 300, created_at_i: 1_700_000_000, objectID: "1" },
        { title: "Ask HN: tools?", url: null, points: 40, created_at_i: 1_700_000_100, objectID: "2" },
        { title: "", url: "https://x.example", objectID: "3" },
      ],
    });
    const items = parseHn(body);
    expect(items.length).toBe(2);
    expect(items[0]).toMatchObject({ title: "Rust 2.0", source: "Hacker News", score: 300, publishedAt: 1_700_000_000_000 });
    expect(items[1]!.url).toBe("https://news.ycombinator.com/item?id=2");
  });
  test("lobsters json", () => {
    const body = JSON.stringify([
      { title: "A", url: "https://a.example", score: 20, created_at: "2026-01-01T00:00:00.000-06:00", comments_url: "https://lobste.rs/s/x" },
    ]);
    const [item] = parseLobsters(body);
    expect(item).toMatchObject({ title: "A", source: "Lobsters", score: 20 });
    expect(item!.publishedAt).toBe(Date.parse("2026-01-01T00:00:00.000-06:00"));
  });
  test("dev.to uses reactions as score", () => {
    const body = JSON.stringify([{ title: "T", url: "https://dev.to/t", public_reactions_count: 55, published_at: "2026-02-01T00:00:00Z", description: "d" }]);
    expect(parseDevto(body)[0]).toMatchObject({ source: "DEV", score: 55, snippet: "d" });
  });
  test("stack exchange items", () => {
    const body = JSON.stringify({ items: [{ title: "How &amp; why", link: "https://stackoverflow.com/q/1", score: 9, creation_date: 1_700_000_000 }] });
    expect(parseStackExchange(body)[0]).toMatchObject({ title: "How & why", source: "Stack Overflow", score: 9 });
  });
  test("daily.dev feed", () => {
    const body = JSON.stringify({ data: [{ title: "Post", url: "https://x.example/p", numUpvotes: 12, createdAt: "2026-03-01T00:00:00Z" }] });
    expect(parseDailyDev(body)[0]).toMatchObject({ source: "daily.dev", score: 12 });
  });
  test("garbage never throws", () => {
    for (const fn of [parseHn, parseLobsters, parseDevto, parseStackExchange, parseDailyDev, parseRss]) {
      expect(fn("<<<not json")).toEqual([]);
    }
  });
});

describe("parseRss", () => {
  test("rss 2.0 with CDATA and entities", () => {
    const xml = `<rss><channel><title>Site</title>
      <item><title><![CDATA[Hello &amp; world]]></title><link>https://s.example/1</link><pubDate>Mon, 01 Jan 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Hi <b>there</b></p>]]></description></item>
      <item><title>No link</title></item></channel></rss>`;
    const items = parseRss(xml, "Site");
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ title: "Hello & world", url: "https://s.example/1", source: "Site", snippet: "Hi there" });
    expect(items[0]!.publishedAt).toBe(Date.parse("Mon, 01 Jan 2026 10:00:00 GMT"));
  });
  test("atom with link href", () => {
    const xml = `<feed><entry><title>Atom one</title><link rel="alternate" href="https://a.example/1"/><updated>2026-01-02T00:00:00Z</updated><summary>S</summary></entry></feed>`;
    expect(parseRss(xml, "A")[0]).toMatchObject({ title: "Atom one", url: "https://a.example/1" });
  });
  test("only https links survive", () => {
    const xml = `<rss><channel><item><title>x</title><link>http://insecure.example/1</link></item><item><title>y</title><link>javascript:alert(1)</link></item></channel></rss>`;
    expect(parseRss(xml, "S")).toEqual([]);
  });
});

describe("discoverFeedUrl", () => {
  test("finds rss and atom alternates, resolves relative hrefs", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" title="x" href="/feed.xml"></head>`;
    expect(discoverFeedUrl(html, "https://blog.example/post")).toBe("https://blog.example/feed.xml");
    const atom = `<link href="https://o.example/atom" type="application/atom+xml" rel="alternate">`;
    expect(discoverFeedUrl(atom, "https://blog.example/")).toBe("https://o.example/atom");
  });
  test("none found is null", () => {
    expect(discoverFeedUrl("<html></html>", "https://x.example")).toBeNull();
  });
});

describe("dedupeCandidates", () => {
  const c = (url: string, score: number, source = "s") => ({ title: "t", url, source, score, publishedAt: 1, snippet: "" });
  test("same url across sources keeps the highest score once", () => {
    const out = dedupeCandidates([c("https://a.example/x?utm_source=1", 5, "hn"), c("https://www.a.example/x", 50, "lobsters"), c("https://b.example", 1)]);
    expect(out.length).toBe(2);
    expect(out.find((i) => i.url.includes("a.example"))!.score).toBe(50);
  });
  test("drops urls already sent", () => {
    const sent = new Set([urlHash("https://a.example/x")]);
    expect(dedupeCandidates([c("https://a.example/x", 5)], sent)).toEqual([]);
  });
});
