# Personalities — notes to merge into CHANGELOG.md and MEMORY.md

Kept separate because another branch was editing CHANGELOG.md and MEMORY.md
when this landed. Paste each section into its file, then delete this one.

## For CHANGELOG.md

### 2026-10-16 — Personalities and unprompted check-ins (`feat/personalities`)

- Four personalities: Project Manager (default), Corporate PA, Mom, Friend.
  Defined in `convex/lib/personas.ts` (voice + check-in slots), stored in
  `preferences` under `persona` and `persona.checkins`. No schema change.
- Switching: `persona.set` tool ("switch to mom"), `/persona [name]`,
  `/checkins on|off`. `/help` lists both.
- The personality's voice block goes into the chat prompt and the morning
  check-in. It says tone only: approval and mailbox rules are unchanged.
- New cron `personality check-ins`, every 30 min 07:00–22:59 WAT, calling
  `checkins.tick`. Sends only when the active personality has a slot due;
  once per slot per day (`calendarNudges` claim), 2-hour minimum gap, held
  while the user wrote in the last 20 minutes. Messages recorded with
  kind `checkin`. Failures go to `reportIncident` as warn.
- `briefs.ts`: `gatherAndCompose` split into `gatherFacts` (shared) +
  composers; new `composeCheckin` and `loadPersona`.
- `preferences.get` query added.
- docs/BEHAVIOUR.md §9 Personalities (hard rules are now §10).
- tests/unit/personas.test.ts (31 tests).

## For MEMORY.md

- 2026-10-16: personalities shipped on `feat/personalities` (bundle
  `personalities.bundle`, base main 1be6656). Default persona is Project
  Manager. Check-in times live only in `convex/lib/personas.ts`; change them
  there. Test on dev with
  `bunx convex run checkins:tick '{"force":true}'` (optionally
  `"persona":"mom"`), which bypasses the time slot and the once-a-day claim.
- Not done yet: per-user custom check-in times, user-defined personalities,
  skipping a check-in when the facts are empty.

## Check-in schedules v2 (2026-10-16, for CHANGELOG.md)

- Mom 5×/day (07:30 wake, 09:00 start, 13:00, 18:00 wrap, 22:00 bed); PM
  3× (09:00 stand-up, 13:30, 18:00); Corporate PA 4 fixed (08:30, 12:00,
  15:30, 17:30) plus a watch 08:00–19:00; Friend 3× (10:00, 15:00, 20:30).
- Minimum gap is per persona (`minGapMinutes`): Mom 75, PA 60, PM/Friend 120.
- PA watch (`decideWatch`): a prep check-in ~60 min before each event
  (once per event), and a status ping when the user has been quiet for
  180 min minus 20 per in-progress/due-today task (floor 90) plus a
  day-seeded 0–45 min jitter, naming the specific task.

## Tone, single-purpose check-ins, meeting flow (2026-10-17, for CHANGELOG.md)

- Voices rewritten from live feedback: Mom is a "corporate mom" (persistent,
  demanding, never "I love you"/pet names/hearts); PM a real delivery lead;
  PA a real executive assistant; Friend unchanged.
- Check-ins: one purpose, one question, two lines (`checkinInstructions`).
  Only the PM (`multiAsk: true`) lists up to three tasks as status asks.
  Every slot purpose and both PA watch purposes rewritten to a single ask.
- Meeting flow (`convex/lib/calendar/meetingFlow.ts`, `reminders.nudgeUpcoming`):
  "Are you joining?" up to 3 h ahead (not before 07:00), then "Ready to
  join?" at MEETING_NUDGE_MINUTES (default now 10, was 30) with the prep
  notes. Attending=false skips the ready nudge. The ready nudge keeps the
  old calendarNudges key, so nothing is double-sent across the deploy.
- New tool `meeting.prep` (titleFragment?, note?, attending?), stored in
  `preferences` under `meeting.prep:<eventId>`. SCOPE rule 11 MEETINGS,
  including writing up a blocker as a sayable update.
