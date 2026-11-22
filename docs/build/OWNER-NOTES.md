# Owner notes — the quiet-agent build (Phases 22-25)

Newest first. Questions that block anything are in the next section. Everything else was decided, with the reason.

## Questions waiting for you

None yet.

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
