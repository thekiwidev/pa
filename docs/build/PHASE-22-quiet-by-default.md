# Phase 22 — Quiet by default (attention budget)

Source plan: `~/.claude/plans/pasted-content-id-d370-all-right-curried-fern.md`, Phase 22. Status: built, not yet observed on dev for 48 h.

## What it does

The bot used to send 3 check-ins and 5-6 verses a day, every day, and paged harder the longer the owner stayed silent. Now every unprompted message passes one pure policy, `convex/lib/notify/policy.ts`, and silence from the owner lowers the volume instead of raising it.

## How it works

- **Activity.** `users.lastInboundAt` is set in `model/messages.record` whenever `direction === "in"` (covers all five inbound paths) and by `model/users.touch` for button taps (`assistant.handleCallback`).
- **Policy.** `decideSend({kind, prefs, now, lastInboundAt, tz, urgent?})` returns `send | drop | defer`. Modes `normal | quiet | silent` (optional `until`). Effective mode drops to `quiet` after `inactivityHours` (default 24) without an inbound message; the next message restores it. Dropped items are never queued. `defer` is only returned for mail kinds inside quiet hours; the caller moves the alert to `quietHoursEndMs` (wired in Phase 23).
- **Kinds and defaults.** On: `email_important`, `email_unread_followup`, `reminder`, `digest`, `news`, `meeting_nudge`, `ops_critical`, `ops_digest`. Opt-in (off): `checkin`, `scripture`, `saved_nudge`, `weekend_pick`. `reminder` and `ops_critical` cannot be switched off.
- **Gate.** `allowProactive(ctx, userId, kind, opts)` in `convex/notify.ts` does one query (`model/users.attention`: activity, `notify` pref, optional legacy pref) and calls `decideSend`. Callers: `checkins.tick`, `scripture.tick/sendMoment/sendMorningBeforeBrief`, `briefs.deliver`, `reminders.nudgeUpcoming`, `saved.nudgeRelevant/weekendPick`, `ops.digest`, `gmail.deliverIfDue`. Ticks gate first, so a dropped tick makes no model call and no calendar/Linear read.
- **Legacy aliases.** If `notify.kinds[kind]` is unset, an explicit older switch is honoured: `persona.checkins` (boolean) and `scripture` pref `enabled`. `persona.set {checkins}`, `/checkins`, `scripture.settings {enabled}` and `/scripture on|off` also write `notify.kinds`.
- **Chat control.** Tool `notify.settings` (non-consequential), `updateNotify()` in `notify.ts` is the single writer of pref key `notify`. Slash: `/silent [2d|12h|90m]`, `/quiet [..]`, `/resume`, `/notify`.
- **Removed.** The "quiet for N minutes, are you done?" ping in `decideWatch` (and `WatchTask`, `idleThresholdMinutes`, the `WatchConfig` idle fields, the Linear/tasks reads in `checkins.watchCheckin`). Only the "event starts soon" prep ping remains for the Corporate PA.
- **Ops.** `REALERT_MS` is 24 h (was 1 h).

## Cost fixes (22.4)

- `emailMessages.upsert` patches only when `labelIds` changed.
- `gmail.accessTokenFor` caches the sealed access token on `connectedAccounts.cachedAccess` (expiry minus 2 min margin); cleared on reconnect and on `markNeedsReauth`.
- Cron "mailbox sync": one job every 30 min around the clock (push is primary). Was every 10 min awake + every 30 min overnight.
- Cron "meeting nudges": every 15 min. The tick schedules `runAt(start - lead + 5 s)` for any event whose "ready" moment falls before the next tick, so the 10-minute nudge is not late.
- `briefs.gatherFacts`: one `notifications.threadKeysSince` range read (new index `by_user_sent`) instead of up to 50 `findByThreadKey` queries.

## Files

`convex/lib/notify/policy.ts` (new), `convex/notify.ts`, `convex/model/{users,messages,notifications,connectedAccounts,emailMessages}.ts`, `convex/schema.ts`, `convex/{checkins,scripture,briefs,reminders,saved,ops,gmail,assistant,crons}.ts`, `convex/lib/{personas,tools/catalog,tools/outcomes,ops/incident}.ts`, `convex/tools/router.ts`, `tests/unit/{notify-policy,personas}.test.ts`.

## Exit criterion and status

Owner silent 48 h on dev produces only important-unread mail alerts and reminders; idle-day Convex function calls fall at least 70 %. **Not verified**: needs 48 h of real silence on dev and the dashboard. Record before and after counts in `docs/build/OWNER-NOTES.md`.
