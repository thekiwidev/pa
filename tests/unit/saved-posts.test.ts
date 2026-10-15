import { describe, expect, test } from "bun:test";
import {
  instagramShortcode,
  parseApifyInstagram,
  parseFxTwitter,
  parseInstagramEmbed,
  tweetIdFromUrl,
} from "../../convex/lib/social/sources";
import { buildSearchText, parseExtraction, renderSavedItem } from "../../convex/lib/saved/extract";
import { fuseHits, mayNudge, normalizeVector, NUDGE_THRESHOLD } from "../../convex/lib/saved/rank";
import {
  buildRowProperties,
  finishedStatus,
  initialStatus,
  isFinishedStatus,
  parseNotionLists,
  pickListColumns,
  resolveListName,
} from "../../convex/lib/notion/lists";
import { assertFetchable } from "../../convex/lib/net/urlGuard";
import { renderOutcomes } from "../../convex/lib/tools/outcomes";

describe("ids from links", () => {
  test("tweet id", () => {
    expect(tweetIdFromUrl("https://x.com/someone/status/1845678901234567890?s=46")).toBe("1845678901234567890");
    expect(tweetIdFromUrl("https://x.com/someone")).toBeNull();
  });
  test("instagram shortcode for posts, reels and user-prefixed links", () => {
    expect(instagramShortcode("https://www.instagram.com/p/DAbc123xyz/?img_index=1")).toBe("DAbc123xyz");
    expect(instagramShortcode("https://www.instagram.com/reel/C9zz_-Q1/")).toBe("C9zz_-Q1");
    expect(instagramShortcode("https://www.instagram.com/filmclub/p/DAbc123xyz/")).toBe("DAbc123xyz");
  });
});

describe("parseFxTwitter", () => {
  test("v1 shape with photos, a video and a quote", () => {
    const post = parseFxTwitter(
      JSON.stringify({
        code: 200,
        tweet: {
          text: "5 open-source scanners you should know",
          author: { name: "Dev", screen_name: "devtips" },
          media: {
            photos: [{ url: "https://pbs.twimg.com/media/a.jpg" }, { url: "https://pbs.twimg.com/media/b.jpg" }],
            videos: [{ url: "https://video.twimg.com/v.mp4", duration: 42, thumbnail_url: "https://pbs.twimg.com/t.jpg" }],
          },
          quote: { text: "quoted", author: { screen_name: "other" } },
        },
      }),
    );
    expect(post?.caption).toBe("5 open-source scanners you should know");
    expect(post?.author).toBe("@devtips");
    expect(post?.images).toEqual([
      "https://pbs.twimg.com/media/a.jpg",
      "https://pbs.twimg.com/media/b.jpg",
      "https://pbs.twimg.com/t.jpg",
    ]);
    expect(post?.videos).toEqual([{ url: "https://video.twimg.com/v.mp4", durationSec: 42 }]);
    expect(post?.quoted).toEqual({ author: "@other", text: "quoted" });
  });
  test("garbage is null, not a crash", () => {
    expect(parseFxTwitter("<html>")).toBeNull();
    expect(parseFxTwitter("{}")).toBeNull();
  });
});

describe("parseApifyInstagram", () => {
  test("a carousel lists every slide", () => {
    const post = parseApifyInstagram(
      JSON.stringify([
        {
          type: "Sidecar",
          caption: "Movies for this weekend 🍿",
          ownerUsername: "filmclub",
          displayUrl: "https://scontent.cdninstagram.com/cover.jpg",
          childPosts: [
            { displayUrl: "https://scontent.cdninstagram.com/1.jpg" },
            { displayUrl: "https://scontent.cdninstagram.com/2.jpg" },
            { displayUrl: "https://scontent.cdninstagram.com/3.jpg", videoUrl: "https://scontent.cdninstagram.com/3.mp4" },
          ],
        },
      ]),
    );
    expect(post?.images).toHaveLength(3);
    expect(post?.author).toBe("@filmclub");
    expect(post?.videos).toEqual([{ url: "https://scontent.cdninstagram.com/3.mp4" }]);
  });
  test("an actor error is null", () => {
    expect(parseApifyInstagram(JSON.stringify([{ error: "not_found" }]))).toBeNull();
  });
});

describe("parseInstagramEmbed", () => {
  test("reads display_url JSON and the caption block", () => {
    const html =
      '<script>{"display_url":"https:\\/\\/scontent.cdninstagram.com\\/a.jpg?x=1\\u0026y=2"},{"display_url":"https:\\/\\/scontent.cdninstagram.com\\/b.jpg"}</script>' +
      '<span class="UsernameText">filmclub</span>' +
      '<div class="Caption"><a class="CaptionUsername" href="#">filmclub</a>Weekend picks<br/>&amp; more<div class="CaptionComments"></div></div>';
    const post = parseInstagramEmbed(html);
    expect(post.images).toEqual(["https://scontent.cdninstagram.com/a.jpg?x=1&y=2", "https://scontent.cdninstagram.com/b.jpg"]);
    expect(post.caption).toBe("Weekend picks\n& more");
    expect(post.author).toBe("@filmclub");
  });
});

describe("url guard covers the media CDNs", () => {
  test("allowed", () => {
    for (const u of [
      "https://pbs.twimg.com/media/a.jpg",
      "https://video.twimg.com/v.mp4",
      "https://scontent-lhr8-1.cdninstagram.com/a.jpg",
      "https://scontent.xx.fbcdn.net/a.jpg",
      "https://api.fxtwitter.com/status/1",
      "https://t.co/abc",
    ]) {
      expect(() => assertFetchable(u)).not.toThrow();
    }
  });
  test("lookalikes still rejected", () => {
    expect(() => assertFetchable("https://twimg.com.evil.net/a.jpg")).toThrow();
  });
});

describe("parseExtraction", () => {
  test("keeps every entity, dedupes, drops junk", () => {
    const x = parseExtraction(
      JSON.stringify({
        title: "10 movies for this weekend",
        summary: "A list of films.",
        kind: "list",
        slides: [{ index: 1, text: "Arrival (2016)" }, { index: 2, text: "" }],
        entities: [
          { type: "movie", name: "Arrival", detail: "2016" },
          { type: "movie", name: "arrival" },
          { type: "spaceship", name: "Dune" },
          { name: "" },
          { type: "tool", name: "Nuclei", url: "javascript:alert(1)" },
        ],
        tags: ["Movies", "Weekend"],
      }),
      "fallback",
    );
    expect(x.entities).toEqual([
      { type: "movie", name: "Arrival", detail: "2016" },
      { type: "other", name: "Dune" },
      { type: "tool", name: "Nuclei" },
    ]);
    expect(x.slides).toEqual([{ index: 1, text: "Arrival (2016)" }]);
    expect(x.tags).toEqual(["movies", "weekend"]);
  });
  test("non-JSON keeps the post with a fallback title", () => {
    const x = parseExtraction("sorry I can't", "Post from @a");
    expect(x.title).toBe("Post from @a");
    expect(x.entities).toEqual([]);
  });
});

describe("search text and render", () => {
  test("entity names are searchable", () => {
    expect(buildSearchText({ title: "Scanners", entities: [{ name: "Nuclei", detail: "vuln scanner" }] })).toContain(
      "Nuclei vuln scanner",
    );
  });
  test("render lists entities and, in full mode, slides", () => {
    const text = renderSavedItem(
      {
        itemId: "k1",
        platform: "instagram",
        url: "https://instagram.com/p/x",
        title: "Movies",
        savedAtText: "Thu 15 Oct",
        status: "ready",
        entities: [{ type: "movie", name: "Arrival", detail: "2016", status: "in_list" }],
        slides: [{ index: 1, text: "Arrival" }],
      },
      true,
    );
    expect(text).toContain("movie: Arrival — 2016 [in_list]");
    expect(text).toContain("--- Slide 1 ---");
  });
});

describe("ranking and nudges", () => {
  test("fusion rewards items found by both searches", () => {
    const fused = fuseHits([{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }], ["b", "c"]);
    expect(fused[0]?.id).toBe("b");
  });
  test("nudge rules", () => {
    const now = 1e12;
    expect(mayNudge({ score: NUDGE_THRESHOLD, nudgesToday: 0, now })).toBe(true);
    expect(mayNudge({ score: 0.99, nudgesToday: 1, now })).toBe(false);
    expect(mayNudge({ score: 0.99, nudgesToday: 0, lastSurfacedAt: now - 1000, now })).toBe(false);
    expect(mayNudge({ score: NUDGE_THRESHOLD + 0.01, nudgesToday: 0, downvotes: 1, now })).toBe(false);
  });
  test("normalize", () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe("Notion lists", () => {
  test("parse and resolve names loosely", () => {
    const lists = parseNotionLists('{"Movies":"abc-123","tools":"def"}');
    expect(lists).toEqual({ movies: "abc123", tools: "def" });
    expect(resolveListName(lists, "my movies list")).toBe("movies");
    expect(resolveListName(lists, "Movie")).toBe("movies");
    expect(resolveListName(lists, "tool")).toBe("tools");
    expect(resolveListName(lists, "books")).toBeNull();
    expect(parseNotionLists("not json")).toEqual({});
  });
  test("columns are found by type and name", () => {
    const cols = pickListColumns({
      Name: { type: "title" },
      Status: { type: "status", status: { options: [{ name: "To watch" }, { name: "Watched" }] } },
      Source: { type: "url" },
      Year: { type: "rich_text" },
      Type: { type: "select", select: { options: [{ name: "Movie" }, { name: "Series" }] } },
    });
    expect(cols?.title).toBe("Name");
    expect(cols?.status?.kind).toBe("status");
    const props = buildRowProperties(cols!, { name: "Arrival", detail: "2016", sourceUrl: "https://x", type: "movie" });
    expect(props.Status).toEqual({ status: { name: "To watch" } });
    expect(props.Type).toEqual({ select: { name: "Movie" } });
    expect(props.Year).toEqual({ rich_text: [{ text: { content: "2016" } }] });
  });
  test("statuses", () => {
    expect(initialStatus(["Watched", "To watch"])).toBe("To watch");
    expect(isFinishedStatus("Watched")).toBe(true);
    expect(isFinishedStatus("To watch")).toBe(false);
  });
});

describe("finishedStatus", () => {
  test("picks the option that means done", () => {
    expect(finishedStatus(["To watch", "Watching", "Watched"])).toBe("Watched");
    expect(finishedStatus(["Not started", "In progress", "Done"])).toBe("Done");
    expect(finishedStatus(["A", "B"])).toBeUndefined();
  });
});

describe("rendering saved-post tool results", () => {
  test("saved.search shows each post with where it came from", () => {
    const text = renderOutcomes("", [
      {
        name: "saved.search",
        ok: true,
        result: {
          query: "vulnerability scanner",
          count: 1,
          items: [
            {
              itemId: "k1",
              platform: "x",
              url: "https://x.com/a/status/1",
              author: "@a",
              title: "5 open-source security tools",
              savedAtText: "Mon 12 Oct",
              status: "ready",
              entities: [{ type: "tool", name: "Nuclei", detail: "vulnerability scanner" }],
              score: 0.03,
            },
          ],
        },
      },
    ]);
    expect(text).toContain("SAVED POST [k1]");
    expect(text).toContain("Nuclei");
  });

  test("list.query lists what is not finished", () => {
    const text = renderOutcomes("", [
      {
        name: "list.query",
        ok: true,
        result: { list: "movies", source: "notion", total: 3, unfinished: 2, items: [{ name: "Arrival" }, { name: "Dune" }] },
      },
    ]);
    expect(text).toContain("2 not done yet");
    expect(text).toContain("1. Arrival");
  });

  test("an empty search says so instead of inventing", () => {
    const text = renderOutcomes("", [{ name: "saved.search", ok: true, result: { query: "x", count: 0, items: [] } }]);
    expect(text).toContain("Nothing in your saved posts");
  });
});
