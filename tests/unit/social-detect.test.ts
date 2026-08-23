import { describe, expect, test } from "bun:test";
import { detectPlatform, extractUrls } from "../../convex/lib/social/detect";

describe("detectPlatform", () => {
  test.each([
    ["https://www.instagram.com/p/Cabc123/", "instagram"],
    ["https://www.instagram.com/reel/Cabc123/", "instagram"],
    ["https://instagram.com/p/Cabc123", "instagram"],
    ["https://www.tiktok.com/@user/video/7123", "tiktok"],
    ["https://vm.tiktok.com/ZMabc/", "tiktok"],
    ["https://x.com/user/status/123", "x"],
    ["https://twitter.com/user/status/123", "x"],
    ["https://www.linkedin.com/posts/name_slug-activity-123-abc/", "linkedin"],
    ["https://www.facebook.com/user/posts/123", "facebook"],
  ])("%s is %s", (url, platform) => {
    expect(detectPlatform(url)?.platform).toBe(platform as never);
  });

  test("strips tracking parameters from the canonical URL", () => {
    // igshid and utm_* are noise, and a canonical URL makes two pastes of the
    // same post look like the same post.
    const d = detectPlatform("https://www.instagram.com/p/Cabc123/?igshid=xyz&utm_source=ig_web");
    expect(d?.canonicalUrl).toBe("https://www.instagram.com/p/Cabc123/");
  });

  test("keeps a query parameter that identifies the post", () => {
    // Facebook's story.php genuinely needs its ids.
    const d = detectPlatform("https://www.facebook.com/story.php?story_fbid=1&id=2");
    expect(d?.canonicalUrl).toContain("story_fbid=1");
  });

  test("a non-social URL is not detected", () => {
    expect(detectPlatform("https://example.com/post/1")).toBeNull();
  });

  test("a malformed URL is not detected rather than throwing", () => {
    expect(detectPlatform("not a url")).toBeNull();
  });

  test("carries whether the platform can serve slides without a login", () => {
    // Instagram carousels past slide 1 need an authenticated session. Saying
    // so up front is what lets the caller ask for screenshots instead of
    // silently returning one slide as though it were the whole post.
    expect(detectPlatform("https://www.instagram.com/p/x/")?.carouselNeedsLogin).toBe(true);
    expect(detectPlatform("https://x.com/u/status/1")?.carouselNeedsLogin).toBe(false);
  });
});

describe("extractUrls", () => {
  test("finds a bare URL in a sentence", () => {
    expect(extractUrls("check this https://x.com/a/status/1 out")).toEqual([
      "https://x.com/a/status/1",
    ]);
  });

  test("finds several", () => {
    expect(extractUrls("https://x.com/a and https://www.tiktok.com/@b/video/2")).toHaveLength(2);
  });

  test("does not swallow a trailing period", () => {
    expect(extractUrls("see https://x.com/a/status/1.")).toEqual(["https://x.com/a/status/1"]);
  });

  test("does not swallow trailing punctuation in parentheses", () => {
    expect(extractUrls("(https://x.com/a/status/1)")).toEqual(["https://x.com/a/status/1"]);
  });

  test("returns nothing when there is no URL", () => {
    expect(extractUrls("no links here")).toEqual([]);
  });
});
