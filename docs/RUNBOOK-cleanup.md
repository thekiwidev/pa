# Runbook — after the 2026-10-15 cleanup

Everything below needs you: a key, a console, or your Telegram. Run from the
repo root. Nothing here touches production.

## 1. Get the code onto the branch

If you are already on `cleanup/assistant-behaviour`, pull the latest bundle
(fast-forward only, so nothing of yours is overwritten):

```bash
git status --short                              # should show nothing tracked
git pull --ff-only ./cleanup.bundle cleanup/assistant-behaviour
bun install
bun run typecheck && bun test                   # expect 745 pass, 0 fail
```

First time only, from `main`:

```bash
git fetch ./cleanup.bundle cleanup/assistant-behaviour:cleanup/assistant-behaviour
git checkout -f cleanup/assistant-behaviour
```

`-f` is safe here: the branch's first commit is your uncommitted work, saved
as-is. (A `git diff --stat` against the branch beforehand lists your new,
untracked files as "deleted" because git does not compare untracked files.
That is expected and not a loss.)

## 2. OpenAI key and models (free daily tier)

1. In the OpenAI dashboard, **Settings → Data controls → Sharing**: turn on
   sharing for your project. The free daily tokens only apply when it is on.
2. Set the key and model ladders on **dev**:

```bash
bunx convex env set OPENAI_API_KEY sk-...
bunx convex env set OPENAI_MODEL_REASON gpt-5.4-mini,gpt-5-mini
bunx convex env set OPENAI_MODEL_DRAFT gpt-5.4-mini
bunx convex env set OPENAI_MODEL_CHEAP_STRUCTURED gpt-5.4-nano
bunx convex env set AI_PROVIDER_PRIORITY openai,gemini
bunx convex env set AI_ROUTE_CLASSIFY_IMPORTANCE gemini
bunx convex env set AI_ROUTE_TRANSCRIBE_VOICE gemini
# optional: bunx convex env set MEETING_NUDGE_MINUTES 30   (0 = off)
```

Why this split: the planner and drafts get the better mini model; the
classifier runs on every incoming email, so it stays on Gemini's free tier
and never eats the OpenAI budget. Gemini remains the fallback for everything.

## 3. Push to dev and prove the AI chain

```bash
bun run dev                                   # leave running
bunx convex run debug:pingAI '{"task":"PLAN_TOOLS"}'
bunx convex run debug:pingAI '{"task":"CLASSIFY_IMPORTANCE"}'
```

The first should name an OpenAI model, the second a Gemini one.

## 4. Clear old skill copies

Skills you edited in the database override the new defaults.

```bash
bunx convex run debug:skillOverrides '{}'
# for each of morning_brief / check_email listed:
bunx convex run debug:resetSkill '{"name":"morning_brief"}'
bunx convex run debug:resetSkill '{"name":"check_email"}'
```

`resetSkill` prints the old text. Keep anything you want and tell the bot
as an instruction instead.

## 5. Your saved formatting rules

```bash
bunx convex run debug:rawInstructions '{}'
```

Delete any rule that contradicts the new voice (e.g. "always use headings",
"full report"). Ask the bot "show my instructions" and "remove instruction N".

## 6. Google scopes and mailboxes

1. Google Cloud Console → your OAuth client → **Data access**: make sure
   Calendar (read + events), Drive (read-only) and `gmail.modify` are listed.
2. In Telegram, `/reconnect <label>` each mailbox so the new scopes are granted.
   Every connected account's calendar is now read, so reconnect all of them.

## 7. Linear

The bot does not read `LINEAR_API_KEY` directly. `debug:connectLinear` seals
a copy into the database, and that sealed copy is what the bot uses. So a new
key needs both commands:

```bash
bunx convex env set LINEAR_API_KEY 'lin_api_...'     # Linear → Settings → Security & access → Personal API keys
bunx convex run debug:connectLinear '{}'
```

`connectLinear` now tests the key against Linear before saving it. Success
prints your team keys (e.g. `THE — Thekiwidev`). A 401 means Linear itself
rejected the key, so make a fresh one. There is no fallback to the local task
list; that is deliberate.

## 7b. Changing the OpenAI key

```bash
bunx convex env set OPENAI_API_KEY 'sk-...'
bunx convex run debug:pingAI '{"task":"PLAN_TOOLS"}'
```

It is read on every call, so no redeploy or restart is needed. Revoke the old
key in the OpenAI dashboard afterwards.

## 8. Test script (send these to the dev bot)

| Send | Expect |
|---|---|
| *(reply to an alert)* "when did this come in?" | Time and mailbox from the email. No search. |
| "find the email from Polaris about my statement" | One email, one line why, "N others — next / show all". |
| "next" | The next match, no new search. |
| "am I free Thursday?" | Thursday's events across all calendars, then the gaps. |
| "am I free Thursday at 3pm?" | Yes/no first, then anything within an hour. |
| "mark THE-89 done" | "THE-89 → Done", applied immediately. |
| "add tasks: A, B, C" | One card, one Apply tap. |
| "remember I prefer short replies" | One-line confirmation; still known tomorrow. |
| `/brief` or wait for 07:00 | ≤ 5 lines: good morning, today, the first thing. |
| Put an event 35 min ahead | "📅 … in 30 min" within 5 minutes, once. |
| Tap **Draft a reply** on an alert | A draft from the right mailbox, waiting for **Send**. |

## 9. Finish

- Delete `.cleanup-transfer.tgz` and `cleanup.bundle` from the repo folder.
- When happy: `git checkout main && git merge cleanup/assistant-behaviour`.
- Production deploy stays your call (`bunx convex deploy`).
