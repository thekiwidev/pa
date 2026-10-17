// Pure. Reading the full content of a post from the three sources that
// expose more than og: tags: FxTwitter (X), Apify (Instagram) and
// Instagram's own embed page. Every string returned is UNTRUSTED content.

export interface FullPost {
  caption?: string;
  author?: string;
  /** Every image, in slide order. */
  images: string[];
  /** Playable video files, best first. */
  videos: { url: string; durationSec?: number }[];
  /** A quoted tweet, kept apart so "what does the quoted one say" works. */
  quoted?: { author?: string; text?: string };
  /** The post IS a video (a reel), whether or not a playable file was found. */
  isVideo?: boolean;
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** "https://x.com/user/status/123?s=20" → "123". */
export function tweetIdFromUrl(url: string): string | null {
  const m = /\/status(?:es)?\/(\d{5,25})/.exec(url);
  return m?.[1] ?? null;
}

/** "https://www.instagram.com/p/ABC123/?img_index=1" → "ABC123" (also /reel/ and /tv/). */
export function instagramShortcode(url: string): string | null {
  // "/share/reel/<code>" is a share code that redirects to the real post;
  // it is not a shortcode, and the embed page 404s on it.
  if (/instagram\.com\/share\//.test(url)) return null;
  const m = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/.exec(url);
  return m?.[1] ?? null;
}

/**
 * FxTwitter's status JSON. Two shapes are in the wild — v1 `{tweet: {...}}`
 * and v2 `{status: {...}}` — so both are read.
 */
export function parseFxTwitter(body: string): FullPost | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const root = obj(json);
  const tweet = obj(root?.tweet) ?? obj(root?.status);
  if (!tweet) return null;

  const author = obj(tweet.author);
  const media = obj(tweet.media);
  const images: string[] = [];
  const videos: { url: string; durationSec?: number }[] = [];

  for (const p of arr(media?.photos)) {
    const url = s(obj(p)?.url);
    if (url) images.push(url);
  }
  for (const v of arr(media?.videos)) {
    const video = obj(v);
    const url = s(video?.url);
    if (url) videos.push({ url, durationSec: typeof video?.duration === "number" ? video.duration : undefined });
    const thumb = s(video?.thumbnail_url);
    if (thumb && !images.includes(thumb)) images.push(thumb);
  }
  // v2 nests everything under media.all with a type per item.
  for (const m of arr(media?.all)) {
    const item = obj(m);
    const url = s(item?.url);
    if (!url) continue;
    if (item?.type === "photo" && !images.includes(url)) images.push(url);
    if ((item?.type === "video" || item?.type === "gif") && !videos.some((v) => v.url === url)) {
      videos.push({ url, durationSec: typeof item?.duration === "number" ? item.duration : undefined });
    }
  }

  const quote = obj(tweet.quote);
  const text = s(obj(tweet.raw_text)?.text) ?? s(tweet.text);
  return {
    caption: text,
    author: s(author?.screen_name) ? `@${author?.screen_name as string}` : s(author?.name),
    images,
    videos,
    ...(quote
      ? {
          quoted: {
            author: s(obj(quote.author)?.screen_name) ? `@${obj(quote.author)?.screen_name as string}` : undefined,
            text: s(quote.text),
          },
        }
      : {}),
  };
}

/**
 * Apify's Instagram scraper dataset items for one post URL.
 *
 * A carousel ("Sidecar") lists every slide under childPosts; `images` is a
 * flattened copy on some actor versions. Both are read and de-duplicated.
 */
export function parseApifyInstagram(body: string): FullPost | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const item = obj(arr(json)[0]);
  if (!item) return null;
  if (s(item.error)) return null;

  const images: string[] = [];
  const videos: { url: string; durationSec?: number }[] = [];
  const push = (url: unknown) => {
    const u = s(url);
    if (u && !images.includes(u)) images.push(u);
  };

  const children = arr(item.childPosts);
  if (children.length > 0) {
    for (const c of children) {
      const child = obj(c);
      push(child?.displayUrl);
      const video = s(child?.videoUrl);
      if (video) videos.push({ url: video });
    }
  } else {
    for (const url of arr(item.images)) push(url);
    push(item.displayUrl);
  }
  const video = s(item.videoUrl);
  if (video && !videos.some((v) => v.url === video)) {
    videos.unshift({
      url: video,
      durationSec: typeof item.videoDuration === "number" ? item.videoDuration : undefined,
    });
  }

  return {
    caption: s(item.caption),
    author: s(item.ownerUsername) ? `@${item.ownerUsername as string}` : undefined,
    images,
    videos,
    isVideo: item.type === "Video" || item.productType === "clips" || Boolean(video),
  };
}

function unescapeJsonString(v: string): string {
  try {
    return JSON.parse(`"${v}"`) as string;
  } catch {
    return v.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  }
}

/**
 * Instagram's /embed/captioned/ page, served without a login. When it
 * carries the carousel it does so as `display_url` fields in inline JSON;
 * otherwise only the cover `EmbeddedMediaImage`. Best effort, by design.
 */
export function parseInstagramEmbed(html: string): FullPost {
  // The slide list sits inside a JSON document that is itself a STRING
  // ("contextJSON":"{\"display_url\":...}"), so its quotes and slashes are
  // escaped once or twice. Flatten the escaping before matching. Measured
  // 2026-10-16: matching only bare quotes found the cover and nothing else,
  // so an eight-slide carousel read as one slide.
  const flat = html.replace(/\\+"/g, '"').replace(/\\+\//g, "/");
  const clean = (raw: string) => unescapeJsonString(raw.replace(/\\+u0026/g, "&").replace(/\\+/g, "\\"));

  const images: string[] = [];
  for (const m of flat.matchAll(/"display_url"\s*:\s*"([^"]+)"/g)) {
    const url = clean(m[1] ?? "");
    if (url.startsWith("https://") && !images.includes(url)) images.push(url);
  }
  if (images.length === 0) {
    const img = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html);
    if (img?.[1]) images.push(img[1].replace(/&amp;/g, "&"));
  }
  // A carousel's parent repeats its first child's URL; keep the children.
  const videos: { url: string }[] = [];
  for (const m of flat.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)) {
    const url = clean(m[1] ?? "");
    if (url.startsWith("https://") && !videos.some((v) => v.url === url)) videos.push({ url });
  }
  const isVideo = /"is_video"\s*:\s*true/.test(flat) || videos.length > 0;

  const captionBlock = /<div class="Caption">([\s\S]*?)<div class="CaptionComments">/.exec(html)?.[1];
  const caption = captionBlock
    ? captionBlock
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/i, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim()
    : undefined;
  const author = /class="UsernameText">([^<]+)</.exec(html)?.[1];

  return { caption: caption || undefined, author: author ? `@${author}` : undefined, images, videos, isVideo };
}

// ── TikTok (2026-10-17) ─────────────────────────────────────────────────────
//
// Most TikToks the owner saves are PHOTO slideshows ("photo mode"), which
// oEmbed reduces to one cover. Three readers, best first; each parser is
// shape-tolerant because none of these payloads is a documented contract.

/** "/@user/photo/123" and "/@user/video/123" → "123". */
export function tiktokItemId(url: string): string | null {
  const m = /\/(?:video|photo)\/(\d{8,25})/.exec(url);
  return m ? m[1]! : null;
}

/** oEmbed and most readers only accept the /video/ form; the id is the same. */
export function tiktokVideoUrl(url: string): string {
  return url.replace(/\/photo\/(\d{8,25})/, "/video/$1");
}

/** Short share links (vm./vt.tiktok.com, tiktok.com/t/...) must be resolved first. */
export function isTiktokShortLink(url: string): boolean {
  try {
    const u = new URL(url);
    return /^(vm|vt)\.tiktok\.com$/i.test(u.hostname) || /^\/t\//.test(u.pathname);
  } catch {
    return false;
  }
}

function firstUrl(v: unknown): string | undefined {
  if (typeof v === "string") return s(v);
  const o = obj(v);
  if (!o) return undefined;
  return s(arr(o.urlList)[0]) ?? s(arr(o.url_list)[0]) ?? s(o.downloadLink) ?? s(o.url);
}

/** clockworks~tiktok-scraper (Apify) dataset items. */
export function parseApifyTiktok(body: string): FullPost | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const item = obj(arr(json)[0]);
  if (!item || s(item.error)) return null;

  const images: string[] = [];
  for (const slide of [...arr(item.slideshowImageLinks), ...arr(item.imagePost && obj(item.imagePost)?.images)]) {
    const u = firstUrl(slide) ?? firstUrl(obj(slide)?.imageURL);
    if (u && !images.includes(u)) images.push(u);
  }
  const meta = obj(item.videoMeta);
  const videos: { url: string; durationSec?: number }[] = [];
  const duration = typeof meta?.duration === "number" ? meta.duration : undefined;
  for (const u of [...arr(item.mediaUrls), meta?.downloadAddr, meta?.playAddr]) {
    const url = s(u);
    if (url && !videos.some((v) => v.url === url)) videos.push({ url, durationSec: duration });
  }
  const slideshow = item.isSlideshow === true || images.length > 0;
  if (!slideshow) {
    const cover = s(meta?.coverUrl) ?? s(meta?.originalCoverUrl);
    if (cover) images.push(cover);
  }
  const author = s(obj(item.authorMeta)?.name) ?? s(obj(item.authorMeta)?.nickName);
  return {
    caption: s(item.text),
    author: author ? `@${author.replace(/^@/, "")}` : undefined,
    images,
    videos: slideshow ? [] : videos,
    isVideo: !slideshow,
  };
}

/** The JSON TikTok's own web page embeds (`__UNIVERSAL_DATA_FOR_REHYDRATION__`). */
export function parseTiktokPage(html: string): FullPost | null {
  const m = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  const scope = obj(obj(json)?.__DEFAULT_SCOPE__);
  const struct = obj(obj(obj(scope?.["webapp.video-detail"])?.itemInfo)?.itemStruct);
  if (!struct) return null;

  const images: string[] = [];
  for (const img of arr(obj(struct.imagePost)?.images)) {
    const u = firstUrl(obj(img)?.imageURL);
    if (u && !images.includes(u)) images.push(u);
  }
  const video = obj(struct.video);
  const videos: { url: string; durationSec?: number }[] = [];
  if (images.length === 0) {
    for (const u of [video?.downloadAddr, video?.playAddr]) {
      const url = s(u);
      if (url && !videos.some((v) => v.url === url)) {
        videos.push({ url, durationSec: typeof video?.duration === "number" ? video.duration : undefined });
      }
    }
    const cover = s(video?.cover) ?? s(video?.originCover);
    if (cover) images.push(cover);
  }
  const author = s(obj(struct.author)?.uniqueId);
  return {
    caption: s(struct.desc),
    author: author ? `@${author}` : undefined,
    images,
    videos,
    isVideo: arr(obj(struct.imagePost)?.images).length === 0,
  };
}

/** tikwm.com's public reader: `{code:0, data:{images?, play?, title, author}}`. */
export function parseTikwm(body: string): FullPost | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const root = obj(json);
  const data = obj(root?.data);
  if (!data || (typeof root?.code === "number" && root.code !== 0)) return null;
  const images = arr(data.images).map(s).filter((u): u is string => Boolean(u));
  const play = s(data.play) ?? s(data.wmplay);
  const slideshow = images.length > 0;
  if (!slideshow && s(data.cover)) images.push(data.cover as string);
  const author = s(obj(data.author)?.unique_id);
  return {
    caption: s(data.title),
    author: author ? `@${author}` : undefined,
    images,
    videos: !slideshow && play ? [{ url: play, durationSec: typeof data.duration === "number" ? data.duration : undefined }] : [],
    isVideo: !slideshow,
  };
}
