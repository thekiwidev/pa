# Phase 24 — Read any link

Source plan: `~/.claude/plans/pasted-content-id-d370-all-right-curried-fern.md`, Phase 24. Status: built and unit-tested; no live fetch has been run.

## What it does

`link.read` opens any link the owner sends: Instagram, TikTok, X, LinkedIn, Facebook (unchanged), plus Threads, Pinterest, YouTube, Reddit, and any other https page. The result is summarised, saved to `savedItems` and embedded, so `saved.search` and recall work unchanged.

## How it works

- **Detection** (`lib/social/detect.ts`): new platforms `pinterest, threads, youtube, reddit`; any other http(s) host is `web`. Non-web schemes (`javascript:`, `file:`, `mailto:`) are not links. Tracking params stripped as before; web pages keep identifying query strings.
- **Fetch order** (`connectors/social/client.ts#fetchFullPost`):
  - `web`: Jina Reader, `https://r.jina.ai/<url>` (JSON, markdown). We never contact the page host. `JINA_API_KEY` is optional (raises the limit; keyless works).
  - `reddit`: OAuth app (client credentials) then `oauth.reddit.com/<post>.json`; no keys or any failure falls back to Jina.
  - `threads`: tokenless oEmbed `graph.threads.net/v1.0/oembed`, then the og: path.
  - `youtube`: oEmbed title and channel plus the watch page's og:description. Videos are not watched.
  - `pinterest`: the og: path (title, description, `i.pinimg.com` image through vision).
  - Existing X, Instagram, TikTok paths untouched.
- **SSRF posture unchanged**: `assertFetchable` stays an allowlist, now with the new fixed hosts (`r.jina.ai`, `graph.threads.net`, `threads.*`, `pinterest.com`, `pin.it`, `pinimg.com`, `reddit.com`, `redd.it`, `youtube.com`, `youtu.be`, `ytimg.com`). A user's non-allowlisted URL is only passed to Jina as a parameter after `assertWebUrl`: https only, no userinfo, no IP literal, no single-label host, no `.local/.internal/.localhost/.lan/.home/.corp/.intranet/.convex.cloud/.convex.site`.
- **Who chose the URL** (`router.ts` `link.read`): still must appear in a recent inbound message from the owner. Links found in mail or pages are never opened.
- **Size cap fixed**: `guardedFetch` and `fetchMedia` read the stream through `lib/net/stream.ts#readCapped` and stop at the cap instead of buffering the body first.
- **Processing** (`saved.ts#ingestLink`): web pages use new task `SUMMARIZE_PAGE` (DRAFT tier), page text in `untrusted`, output `{title, summary, keyPoints, tags}` (`lib/social/page.ts`); key points are stored as bullets inside the summary; `kind: "article"`. Images from arbitrary sites are not downloaded or stored. Social posts keep `EXTRACT_POST`.
- **Planner text**: prompt rules 8 and 10 and the `link.read` catalog text no longer name five platforms; a link that is only context for another request ("add this to Linear: <link>") is not a reading request.

## Files

`convex/lib/social/{detect,more,page}.ts`, `convex/lib/net/{urlGuard,stream}.ts`, `convex/connectors/social/client.ts`, `convex/saved.ts`, `convex/lib/{ai/tiers,saved/extract,tools/catalog,prompts/assistant}.ts`, `convex/tools/router.ts`, `docs/ENV.md`, tests `social-detect`, `url-guard`, `web-readers`, `stream-cap`.

## Not verified live

Threads tokenless oEmbed, the Jina JSON shape, Reddit client-credentials read, and Pinterest og: tags were written from the plan and public docs, not exercised against the real services. Send one link of each kind on dev (see OWNER-NOTES).
