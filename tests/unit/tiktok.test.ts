import { describe, expect, test } from "bun:test";
import {
  isTiktokShortLink,
  parseApifyTiktok,
  parseTiktokPage,
  parseTikwm,
  tiktokItemId,
  tiktokVideoUrl,
} from "../../convex/lib/social/sources";
import { isAllowedHost } from "../../convex/lib/net/urlGuard";

describe("TikTok links", () => {
  test("photo and video ids", () => {
    expect(tiktokItemId("https://www.tiktok.com/@a/photo/7412345678901234567")).toBe("7412345678901234567");
    expect(tiktokItemId("https://www.tiktok.com/@a/video/7412345678901234567")).toBe("7412345678901234567");
  });
  test("photo links are rewritten to the /video/ form readers accept", () => {
    expect(tiktokVideoUrl("https://www.tiktok.com/@a/photo/7412345678901234567")).toBe(
      "https://www.tiktok.com/@a/video/7412345678901234567",
    );
  });
  test("short share links are recognised", () => {
    expect(isTiktokShortLink("https://vm.tiktok.com/ZMabc123/")).toBe(true);
    expect(isTiktokShortLink("https://www.tiktok.com/t/ZTabc/")).toBe(true);
    expect(isTiktokShortLink("https://www.tiktok.com/@a/video/1234567890")).toBe(false);
  });
  test("TikTok CDNs and the readers are fetchable", () => {
    for (const h of ["p16-sign-va.tiktokcdn.com", "p19-pu-sign-useast8.tiktokcdn-us.com", "www.tikwm.com", "api.apify.com"]) {
      expect(isAllowedHost(h)).toBe(true);
    }
  });
});

describe("parseApifyTiktok", () => {
  test("a slideshow gives every slide, in order, and no video", () => {
    const post = parseApifyTiktok(
      JSON.stringify([
        {
          text: "5 money habits",
          authorMeta: { name: "coach" },
          isSlideshow: true,
          slideshowImageLinks: [
            { tiktokLink: "https://p16.tiktokcdn.com/1.jpeg", downloadLink: "https://api.apify.com/kv/1.jpeg" },
            { tiktokLink: "https://p16.tiktokcdn.com/2.jpeg", downloadLink: "https://api.apify.com/kv/2.jpeg" },
          ],
          videoMeta: { duration: 10, downloadAddr: "https://v16.tiktokcdn.com/music.mp4" },
        },
      ]),
    )!;
    expect(post.caption).toBe("5 money habits");
    expect(post.author).toBe("@coach");
    expect(post.images).toEqual(["https://api.apify.com/kv/1.jpeg", "https://api.apify.com/kv/2.jpeg"]);
    expect(post.videos).toEqual([]);
    expect(post.isVideo).toBe(false);
  });
  test("a video gives its file and duration", () => {
    const post = parseApifyTiktok(
      JSON.stringify([{ text: "t", mediaUrls: ["https://api.apify.com/kv/v.mp4"], videoMeta: { duration: 42, coverUrl: "https://p16.tiktokcdn.com/c.jpeg" } }]),
    )!;
    expect(post.videos[0]).toEqual({ url: "https://api.apify.com/kv/v.mp4", durationSec: 42 });
    expect(post.images).toEqual(["https://p16.tiktokcdn.com/c.jpeg"]);
    expect(post.isVideo).toBe(true);
  });
  test("an error item is no post", () => {
    expect(parseApifyTiktok(JSON.stringify([{ error: "not found" }]))).toBeNull();
  });
});

describe("parseTiktokPage", () => {
  const page = (struct: unknown) =>
    `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
      __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: struct } } },
    })}</script></html>`;
  test("photo mode", () => {
    const post = parseTiktokPage(
      page({
        desc: "Hacks",
        author: { uniqueId: "home" },
        imagePost: { images: [{ imageURL: { urlList: ["https://p16.tiktokcdn.com/a"] } }, { imageURL: { urlList: ["https://p16.tiktokcdn.com/b"] } }] },
        video: { playAddr: "https://v16.tiktokcdn.com/bgm.mp4" },
      }),
    )!;
    expect(post.images).toEqual(["https://p16.tiktokcdn.com/a", "https://p16.tiktokcdn.com/b"]);
    expect(post.videos).toEqual([]);
    expect(post.author).toBe("@home");
  });
  test("video", () => {
    const post = parseTiktokPage(page({ desc: "v", video: { playAddr: "https://v16.tiktokcdn.com/v.mp4", duration: 30, cover: "https://p16.tiktokcdn.com/c" } }))!;
    expect(post.videos).toEqual([{ url: "https://v16.tiktokcdn.com/v.mp4", durationSec: 30 }]);
    expect(post.isVideo).toBe(true);
  });
  test("a page without the data is null", () => {
    expect(parseTiktokPage("<html>login</html>")).toBeNull();
  });
});

describe("parseTikwm", () => {
  test("slideshow", () => {
    const post = parseTikwm(JSON.stringify({ code: 0, data: { title: "x", images: ["https://p16.tiktokcdn.com/1", "https://p16.tiktokcdn.com/2"], play: "https://x/bgm.mp3", author: { unique_id: "u" } } }))!;
    expect(post.images).toHaveLength(2);
    expect(post.videos).toEqual([]);
  });
  test("video", () => {
    const post = parseTikwm(JSON.stringify({ code: 0, data: { title: "x", play: "https://www.tikwm.com/video/media/play/1.mp4", duration: 20, cover: "https://p16.tiktokcdn.com/c" } }))!;
    expect(post.videos[0]!.durationSec).toBe(20);
    expect(post.isVideo).toBe(true);
  });
  test("an error code is null", () => {
    expect(parseTikwm(JSON.stringify({ code: -1, msg: "Url parsing is failed!" }))).toBeNull();
  });
});

import { sniffImageMime } from "../../convex/lib/net/sniff";
test("HEIC slides are recognised", () => {
  const b = new Uint8Array([0, 0, 0, 0x18, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
  expect(sniffImageMime(b)).toBe("image/heic");
});
