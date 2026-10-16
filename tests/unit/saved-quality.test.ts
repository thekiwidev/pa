import { describe, expect, test } from "bun:test";
import { parseApifyInstagram, parseInstagramEmbed, instagramShortcode } from "../../convex/lib/social/sources";
import { EXTRACT_POST_SYSTEM, countGapNote, parseExtraction } from "../../convex/lib/saved/extract";
import { sniffImageMime } from "../../convex/lib/net/sniff";
import { messageForRecall } from "../../convex/lib/saved/rank";

// Reported 2026-10-16: an eight-slide household-hacks carousel came back as
// ONE item. The embed page carries every child slide, but inside an escaped
// JSON string, which the old pattern never matched.
describe("embed page: every slide, even inside escaped JSON", () => {
  const escaped =
    '<script>window.x = {"contextJSON":"{\\"gql_data\\":{\\"shortcode_media\\":{\\"is_video\\":false,' +
    '\\"edge_sidecar_to_children\\":{\\"edges\\":[' +
    '{\\"node\\":{\\"display_url\\":\\"https:\\\\/\\\\/scontent.cdninstagram.com\\\\/v\\\\/s1.jpg?a=1\\\\u0026b=2\\"}},' +
    '{\\"node\\":{\\"display_url\\":\\"https:\\\\/\\\\/scontent.cdninstagram.com\\\\/v\\\\/s2.jpg\\"}},' +
    '{\\"node\\":{\\"display_url\\":\\"https:\\\\/\\\\/scontent.cdninstagram.com\\\\/v\\\\/s3.jpg\\"}}' +
    ']}}}}"};</script>' +
    '<img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/v/s1.jpg?a=1&amp;b=2">';

  test("all three slides, in order, unescaped, no duplicate cover", () => {
    const post = parseInstagramEmbed(escaped);
    expect(post.images).toEqual([
      "https://scontent.cdninstagram.com/v/s1.jpg?a=1&b=2",
      "https://scontent.cdninstagram.com/v/s2.jpg",
      "https://scontent.cdninstagram.com/v/s3.jpg",
    ]);
    expect(post.isVideo).toBe(false);
  });

  test("a reel's video_url is picked up, and it is marked as a video", () => {
    const html =
      '{"contextJSON":"{\\"shortcode_media\\":{\\"is_video\\":true,\\"video_url\\":\\"https:\\\\/\\\\/scontent.cdninstagram.com\\\\/o1\\\\/v.mp4?x=1\\\\u0026y=2\\",' +
      '\\"display_url\\":\\"https:\\\\/\\\\/scontent.cdninstagram.com\\\\/cover.jpg\\"}}"}';
    const post = parseInstagramEmbed(html);
    expect(post.isVideo).toBe(true);
    expect(post.videos[0]?.url).toBe("https://scontent.cdninstagram.com/o1/v.mp4?x=1&y=2");
  });
});

describe("Apify marks videos", () => {
  test("type Video with a videoUrl", () => {
    const post = parseApifyInstagram(
      JSON.stringify([{ type: "Video", videoUrl: "https://x.cdninstagram.com/v.mp4", displayUrl: "https://x.cdninstagram.com/c.jpg", videoDuration: 42 }]),
    );
    expect(post?.isVideo).toBe(true);
    expect(post?.videos[0]).toEqual({ url: "https://x.cdninstagram.com/v.mp4", durationSec: 42 });
  });
});

describe("share links", () => {
  test("a /share/ code is not mistaken for a post shortcode", () => {
    expect(instagramShortcode("https://www.instagram.com/share/reel/BAabc123/")).toBeNull();
    expect(instagramShortcode("https://www.instagram.com/share/p/BAabc123/")).toBeNull();
  });
});

describe("extraction reads the post the way its caption frames it", () => {
  test("the prompt covers framing, promo slides and the promised count", () => {
    expect(EXTRACT_POST_SYSTEM).toMatch(/caption/i);
    expect(EXTRACT_POST_SYSTEM).toMatch(/follow/i);
    expect(EXTRACT_POST_SYSTEM).toMatch(/expectedCount/);
    expect(EXTRACT_POST_SYSTEM).toMatch(/video/i);
  });

  test("expectedCount and promo slides are parsed", () => {
    const x = parseExtraction(
      JSON.stringify({
        title: "6 household hacks",
        expectedCount: 6,
        slides: [
          { index: 1, text: "CENTIPEDES — sprinkle salt" },
          { index: 8, text: "Follow us for more", promo: true },
        ],
        entities: [{ type: "tip", name: "Keep centipedes away", detail: "Sprinkle salt around entry points" }],
      }),
      "x",
    );
    expect(x.expectedCount).toBe(6);
    expect(x.slides.find((s) => s.index === 8)?.promo).toBe(true);
  });

  test("a gap between what the caption promises and what was found is said out loud", () => {
    expect(countGapNote(6, 6)).toBeUndefined();
    expect(countGapNote(undefined, 1)).toBeUndefined();
    expect(countGapNote(10, 1)).toBe("the post promises 10 items but I could only find 1");
  });
});

describe("image type from the bytes, not the CDN header", () => {
  test("jpeg, png, webp; unknown stays null", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

// Reported 2026-10-16: after "forget that video", a new unrelated link got
// answers about the old video. A message carrying a new link is a new topic:
// saved posts are not pulled in for it.
describe("which messages pull saved posts into the reply", () => {
  test("a message with a link pulls nothing", () => {
    expect(messageForRecall("https://www.instagram.com/p/ABC/ what's this")).toBeNull();
  });
  test("commands and short messages pull nothing", () => {
    expect(messageForRecall("/health")).toBeNull();
    expect(messageForRecall("ok thanks")).toBeNull();
  });
  test("an ordinary question is used as-is", () => {
    expect(messageForRecall("what was that open source security scanner?")).toBe(
      "what was that open source security scanner?",
    );
  });
});
