# Owner notes — the quiet-agent build (Phases 22-25)

Newest first. Questions that block anything are in the next section. Everything else was decided, with the reason.

## Questions waiting for you

None yet.

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
