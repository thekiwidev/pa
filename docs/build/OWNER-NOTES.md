# Owner notes — the quiet-agent build (Phases 22-25)

Newest first. Questions that block anything are in the next section. Everything else was decided, with the reason.

## Questions waiting for you

None yet.

## Your to-do after Phase 26

- [ ] `TAVILY_API_KEY` is set on prod. Optional: `WEB_SEARCH_DAILY_CAP`.
- [ ] Ask "search for the latest Claude release": expect a few sourced lines.
- [ ] Ask "is it true that <something recent>": it should name its sources and say if they disagree.
- [ ] Say "catch me up on tech": expect launches and offers first. If generic blog posts still lead, send me the output.
- [ ] Ask it to open one of the results in full.

## Decisions made without you (Phase 26)

| Decision | Why |
|---|---|
| Baseline interests are code, merged at ranking | you are already seeded; a constant needs no migration |
| Search result urls stored in the audit log | no new table; keeps the append-only log as the only record |
| No LLM relevance judge yet | a model call per story costs more than ranking first |

## Your to-do after Phase 25

- [ ] Optional keys: `DAILYDEV_TOKEN` (may need daily.dev Plus), `STACKEXCHANGE_KEY` (optional), Reddit keys from Phase 24. Names in `docs/ENV.md`. Without them those sources are skipped.
- [ ] Dev run: say "catch me up on tech". Expect one card of 5 stories in under 60 s. If fewer than 5 sources contribute, `bunx convex run model/news:sources '{"userId":"..."}'` and `bun run logs` show which one failed (warn incidents named `news.<kind>`).
- [ ] Say "I'm into Rust for a week", then "catch me up": Rust stories should rise. `interest.list` shows the expiry.
- [ ] Tap 👍 and 👎 on stories and check `interest.list` shows a learned topic.
- [ ] Say "watch https://<some blog>", then "list my sources".
- [ ] Say "add news to my morning digest" and "also send news at 1pm". Check the reply names both times. Then `/brief` is unchanged.
- [ ] Send a link and ask "what's important on this site": `web.read`. Ask it to follow a link to another domain: it must refuse.
- [ ] To read TLDR/Snapbyte by mail: subscribe with your Gmail, then "read my TLDR emails" (sender `@tldrnewsletter.com`).
- [ ] Production: not deployed. Phase 25 adds four tables and one cron, all additive.

## Decisions made without you (Phase 25)

| Decision | Why |
|---|---|
| Read bodies for the ranked top N only, not 15 | ranking is done before reading; reading extra only costs Jina calls |
| No embeddings stored on `newsItems` | big rows for a 7-day pool; the top 60 are embedded per run |
| Owner RSS fetched directly with per-hop `assertWebUrl` | Jina returns markdown, and the owner typed the url |
| `web.read` accepts up to 4 urls per call | the planner's step limit bounds the loop; the guard checks each url |
| One newsletter issue is one story | only plain text is stored for mail |
| Digest `reschedule` computes the next slot itself | flat +24 h cannot express several times a day |
| Per-kind `news` policy not used for the digest news section | the digest's own `digest` gate already decides whether anything is sent |

## Your to-do after Phase 24

- [ ] Optional keys (each source is skipped without its key): `bunx convex env set JINA_API_KEY ...` (free key at jina.ai; raises the rate limit), and for Reddit create a "script" app at reddit.com/prefs/apps then set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`. Names only are in `docs/ENV.md`.
- [ ] Live test on dev: send one link each of Pinterest, Threads, YouTube, Reddit and a blog article. Expect a summary and `saved.recent` to list them. An `http://` link and an IP link must be refused.
- [ ] Tell me which of Threads, Pinterest, Jina or Reddit misbehaves; those four were not exercised live.

## Decisions made without you (Phase 24)

| Decision | Why |
|---|---|
| Jina used keyless when no key | reading pages is the feature; a key only raises the limit |
| YouTube: title and description only | video cannot be downloaded over plain HTTP |
| Web images not stored | no URL field on `savedItems`; avoids vision on arbitrary hosts |
| Key points stored as bullets in the summary | no schema change, still searchable and embedded |

## Your to-do after Phase 23

- [ ] Dev mailbox test: send yourself an important-sounding mail (e.g. "Invoice due Friday"). Read it on your phone within 15 min: expect no alert. Leave another unread: expect one alert at 15 min and one at 48 h.
- [ ] Send a login notice ("new sign-in to your account"): expect no alert.
- [ ] In chat: "alert me: anything from <your landlord>". Then send a mail from that sender; it should be HIGH.
- [ ] `bunx convex codegen` already pushed the new `alertIfUnread` action to dev. Production: not deployed; `notifications.followupSentAt` is an additive field.

## Decisions made without you (Phase 23)

| Decision | Why |
|---|---|
| Already-read mail never alerts, even CRITICAL | alerting on read mail adds nothing; plan said "as today" for CRITICAL, I judged that a gap |
| Follow-up limited per thread via `notifications.followupSentAt` | the row is per thread; stricter than the plan, never noisier |
| Fail open when Gmail cannot be asked | a missed important mail costs more than a duplicate |
| Classifier v4 not backfilled | re-classifying history would burn model quota for no alert benefit |

## Your to-do after Phase 22

- [ ] Redeploy is not needed for code already pushed to dev by `bunx convex codegen`; run `bun run dev` to keep dev in sync.
- [ ] Record the idle-day function-call count from the Convex dashboard before and after (the plan's 70 % target). Before: ____ After: ____
- [ ] Send `/notify` in Telegram to see the new defaults. Turn check-ins or verses back on with `/checkins on`, `/scripture on`, or "turn check-ins on".
- [ ] Be silent for 48 h on dev and confirm only important unread mail and reminders arrive.
- [ ] Production: not deployed. The schema change adds `users.lastInboundAt`, `connectedAccounts.cachedAccess`, and index `notifications.by_user_sent` (all additive; index backfills on a small table).

## Decisions made without you (Phase 22)

| Decision | Why |
|---|---|
| `allowProactive` helper instead of a `deliverProactive` action | no extra function call per message; senders keep their own channel call; same enforcement |
| `lastInboundAt` written inside `messages.record` | one change covers all 5 inbound paths |
| Owner with no `lastInboundAt` is treated as inactive | fail quiet, not noisy |
| Dropped scripture/check-in spacing rule | 50-row scan retired; both are opt-in now |
| Meeting nudge: 15 min cron plus `runAt` for the ready nudge | plain 15 min would miss the 10-min nudge |
| Idle-ping removed along with its Linear/tasks reads | also saves two API reads per tick |
