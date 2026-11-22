# Phase 25 — News agent and web tasks

Source plan: `~/.claude/plans/pasted-content-id-d370-all-right-curried-fern.md`, Phase 25. Status: built and unit-tested; no live source, model call or Telegram send has been run.

## What it does

- **On demand**: "catch me up on tech", "what's new in AI agents", `/news [topic]`, "top 10" send a ranked newsletter: key points and a why-it-matters line per story, a 👍/👎 pair per story.
- **Scheduled**: `brief.configure` now carries `sections` (`email`, `calendar`, `news`, `verse`) and `extraTimes` (more digests per day, each with its own sections). The digest stays off until the owner asks. News is only ever sent by a digest the owner configured or by a direct ask; there are no breaking-news interrupts.
- **Interests**: `interest.add {topic, days?, avoid?}`, `interest.list`, `interest.remove`. Time-bound ("Rust for two weeks") stops counting from its expiry instant. Learned ones (a saved link, a 👍) decay with a 14-day half-life. "No more crypto" is a negative weight. A 👎 teaches a negative inferred interest.
- **Sources**: `news.source.add / list / remove`. Defaults: Hacker News, Lobsters, DEV, Stack Overflow, Google News, TLDR (RSS), daily.dev (token), r/programming (Reddit app). Owner additions: a site or blog (feed auto-discovered), a newsletter read from mail (`sender`), a subreddit.
- **web.read {urls, question}**: opens a page the owner sent and answers a question; up to 3 more pages of the same registrable domain.

## How it works

Pure, in `convex/lib/news/` (all under `bun test`):

- `normalize.ts`: `NewsCandidate`, parsers for HN (Algolia), Lobsters, DEV, Stack Exchange, daily.dev, Reddit, RSS and Atom, `discoverFeedUrl`, `urlKey`/`urlHash` (tracking params, `www.`, fragment and trailing slash ignored), `dedupeCandidates` (same story from several sources keeps the best score; sent stories dropped).
- `rank.ts`: `interestWeight` (expiry, half-life), `scoreCandidate` (interest match x 3 + recency, half-life 2 days), `rankCandidates` (popularity as a percentile inside its own source, so a 20-point Lobsters story is not buried by a 900-point HN one; no source takes more than half of the list while others can fill it). Interest match uses cosine on embeddings when both exist, otherwise word overlap.
- `sources.ts`: catalogue, `sourceConfigured` (keys), `buildRequest` per kind, `senderMatches`.
- `newsletter.ts`: `WRITE_NEWSLETTER_SYSTEM`, `parseNewsletter` (drops any item whose url was not one of the candidates), `renderNewsletter` (HTML-escaped), `feedbackButtons`.
- `webread.ts`: `webReadVerdict` (`owner` / `same-domain` / refuse), `sameDomainLinks`.

Orchestration in `convex/news.ts`:

1. **Collect** (`collectNews`): seed default sources once, fetch every enabled and configured source in parallel (concurrency 6, 10 s each), dedupe, upsert into `newsItems`. A failing source is a `warn` incident and is skipped.
2. **Rank** (`pickStories`): pool of the last 7 days not yet sent, no-model pre-rank to 60, embed those titles and any interest without a vector in one `embedTexts` call (skipped when no provider), re-rank to `count`.
3. **Read**: Jina bodies for the chosen stories only, 5 at a time, 2,500 characters each. Newsletter-sourced stories use the mail text already stored.
4. **Write**: one `WRITE_NEWSLETTER` call (DRAFT tier). Story text is in `untrusted`; the output schema has no action field. On failure it falls back to headlines only.
5. **Send**: cards of 5 stories each with feedback buttons; chosen stories get `sentAt`; the message is recorded in history.

Tables (`convex/schema.ts`): `newsSources`, `interests`, `newsItems` (indexes `by_user_hash`, `by_user_fetched`, `by_fetched`), `newsFeedback`. A daily cron (`clean news pool`, 03:30 UTC) deletes rows older than 7 days in bounded batches and the owner's lapsed interests.

Digest slots (`convex/model/briefConfig.ts`): `slotsOf(config)` is the main time plus `extraTimes`; `nextSlot` picks the soonest. `deliver` receives `slotTime`, so the right sections are used. After sending it calls `reschedule` with the timezone, which now computes the next slot itself instead of a flat +24 h. A config with no `sections` behaves as before (email, calendar and the morning verse).

Newsletter mail: a `newsletter` source holds a sender pattern. `runAlertStep` in `gmail.ts` returns early for those senders, so they never alert; `collectNews` turns each recent issue into one story (subject, first 400 characters of stored body, a Gmail thread url).

## Decisions

| Decision | Why |
|---|---|
| Bodies are read for the ranked top `count` only, not top 15 | ranking is already done; reading 15 to write 5 costs ten Jina calls for nothing |
| Embeddings are not stored on `newsItems` | thousands of 768-d rows for a 7-day pool; embedding the top 60 per run is one call |
| Owner-added RSS is fetched directly with `assertWebUrl` on every hop, not through Jina | Jina returns markdown, not XML; the owner typed the url |
| `web.read` takes up to 4 urls per call, not a server-driven follow loop | the planner loop already bounds steps; the guard is per url |
| Newsletter issue is one story, not one per link | only plain text is stored for mail; no anchor text to title links with |
| Interests are embedded lazily in the run that needs them | keeps `interest.add` instant and free |
| daily.dev and Reddit sources are default but skipped without keys | "configured by the presence of its key" |

## Known limits and unverified

- Not exercised live: every external endpoint (Algolia, Lobsters, DEV, Stack Exchange, Google News RSS, TLDR RSS path, daily.dev response shape, Reddit OAuth listing) and the newsletter model output.
- TLDR's feed path is third-party listed; the source returns nothing if it is wrong.
- Google News RSS item links are redirect links (`news.google.com/rss/articles/...`); Jina may or may not follow them to the article.
- `web.read` follows are offered as same-site links; the planner decides to call again. No automatic crawl.
- Open web search is not built (needs a search key, see the plan).

## Files

`convex/news.ts`, `convex/lib/news/{normalize,rank,sources,newsletter,webread}.ts`, `convex/connectors/news/client.ts`, `convex/model/{news,interests,briefConfig,emailMessages}.ts`, `convex/{schema,briefs,crons,assistant,gmail,saved,notify}.ts`, `convex/tools/router.ts`, `convex/lib/tools/{catalog,outcomes}.ts`, `convex/lib/{ai/tiers,prompts/assistant}.ts`, `convex/connectors/social/client.ts` (`fetchViaJina` exported). Tests: `news-normalize`, `news-rank`, `news-sources`, `news-tools`.
