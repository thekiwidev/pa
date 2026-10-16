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
