# Phase 26 — Web search and news relevance

Status: built and unit-tested; no live Tavily call, newsletter or Telegram run yet.

## What it does

- **`web.search {query, news?, days?}`**: searches the web through Tavily and returns titles, urls, dated snippets. The assistant answers from the results, names each source and says when results disagree.
- **`web.read` may open a search result**: urls from a `web.search` made in the last 30 minutes count like urls the owner typed. The model never composes a url; the allow list is the stored result set. Same-site follow-ups keep the old limits.
- **Daily cap**: 30 searches a day by default (`WEB_SEARCH_DAILY_CAP`), counted from the existing `web.search` audit rows, so no new table.
- **News relevance**: the newsletter now ranks launches first. A story that matches an interest always outranks one that does not. A standing baseline of interests (Anthropic, OpenAI, Gemini launches, new AI models, AI plan and pricing offers, developer tool launches) is merged in at ranking time and never stored. A "launch watch" runs Tavily news searches (last 3 days) for fixed launch queries plus up to three of the owner's own topics and adds them as the source "Web news".
- **Invariant 2 fix**: interests learned from story or page titles no longer go into the model `input`; they travel in `untrusted`. Only topics the owner typed stay in `input`.

## How it works

- Pure: `convex/lib/web/search.ts` (request body, parsing, cap, result-url window), `convex/lib/news/baseline.ts` (baseline topics, launch queries), `rank.ts` (`interestMatchScore`, relevance-first sort).
- Network: `convex/connectors/web/tavily.ts` (one POST, `TAVILY_API_KEY`; 429/432/433 become "quota used up").
- `web.search` case in `convex/tools/router.ts` writes a `web.search.results` audit row holding the urls; `model/audit.recentSearches` reads both kinds.
- `collectNews` calls `launchWatch` only when `TAVILY_API_KEY` is set; a failing query is a `news.tavily` warning.

## Decisions

| Decision | Why |
|---|---|
| Baseline interests merged at ranking, not seeded | the owner is already seeded; seeding only helps new users, and a constant needs no migration |
| Launch watch is code, not a stored source | same reason; the owner can still silence a topic with "no more X" |
| Result urls kept in the audit log | no new table; auditLogs already has `by_action` and is append-only |
| Search results shown only as snippets by default | reading a page stays a second, visible `web.read` call |
| No LLM relevance judge | an extra model call per story costs more than ranking first; revisit if launches still get buried |

## Known limits and unverified

- Tavily request and response shapes follow its public docs; never called live.
- Without embeddings, baseline matching is word overlap, so a launch phrased with none of the baseline words ranks as unmatched.
- The cap counts denied and errored calls too.

## Files

`convex/lib/web/search.ts`, `convex/lib/news/{baseline,rank,newsletter}.ts`, `convex/connectors/web/tavily.ts`, `convex/{news}.ts`, `convex/model/audit.ts`, `convex/tools/router.ts`, `convex/lib/tools/{catalog,outcomes}.ts`, `convex/lib/prompts/assistant.ts`. Tests: `web-search`, `news-baseline`, `news-rank`.
