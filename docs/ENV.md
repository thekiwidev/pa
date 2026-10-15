# Environment variables

**Names only. Never values.** This file is committed; the real values live in
Convex per-deployment env vars (`bunx convex env set`) and nowhere else.

Set with:

```bash
bunx convex env set --from-file .env.dev            # dev deployment
bunx convex env set --from-file .env.prod --prod    # prod deployment
bunx convex env list          # verify dev
bunx convex env list --prod   # verify prod
```

## Must DIFFER between dev and prod

| Variable | Why |
|---|---|
| `ENCRYPTION_KEY` | Separate key per deployment; both in the password manager |
| `TELEGRAM_BOT_TOKEN` | Separate bot per deployment |
| `TELEGRAM_WEBHOOK_SECRET` | Separate secret per bot |
| `GOOGLE_REDIRECT_URI` | Different `.convex.site` domain |
| `GOOGLE_PUBSUB_TOPIC` | `gmail-push-dev` vs `gmail-push-prod` |

## Identical on both

`TELEGRAM_OWNER_ID` (identifies you, not the bot) · `AI_PROVIDER_PRIORITY` ·
all `*_API_KEY` · all `*_MODEL_*` · `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` ·
`GOOGLE_PUBSUB_AUDIENCE` · `GOOGLE_PUBSUB_SA_EMAIL` · `USER_TIMEZONE` ·
`APPROVAL_TTL_MINUTES` · `MAX_ALERTS_PER_HOUR` · `ZOHO_*` · `MS_*` · `LINEAR_API_KEY
LINEAR_TEAM_KEY
NOTION_API_KEY
NOTION_NOTES_DATABASE_ID`

## First consumed by phase

| Phase | Variables |
|---|---|
| 0 | `ENCRYPTION_KEY` |
| 1 | `TELEGRAM_BOT_TOKEN` `TELEGRAM_WEBHOOK_SECRET` `TELEGRAM_OWNER_ID` `AI_PROVIDER_PRIORITY` `GEMINI_API_KEY` `GEMINI_MODEL_CHEAP_STRUCTURED` `GEMINI_MODEL_REASON` `GEMINI_MODEL_DRAFT` |
| 2 | `USER_TIMEZONE` |
| 3 | `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_REDIRECT_URI` |
| 5 | `MAX_ALERTS_PER_HOUR` |
| 6 | `APPROVAL_TTL_MINUTES` — real sending starts here; `AUTONOMOUS_SEND_ENABLED` still must not exist yet (see phase 18's row) |
| 8 | `GOOGLE_PUBSUB_TOPIC` (full topic path, `projects/<project>/topics/<topic>`) · `GOOGLE_PUBSUB_AUDIENCE` (the push endpoint URL, `https://<deployment>.convex.site/webhooks/gmail`) · `GOOGLE_PUBSUB_SA_EMAIL` (the service account the subscription pushes as). **All three unset = the webhook is closed, not open** — it refuses every push rather than trusting it |
| 9 | `GEMINI_MODEL_TRANSCRIBE` (+ optional `OPENAI_*`, `AI_ROUTE_TRANSCRIBE_VOICE`) |
| 15 | `ZOHO_CLIENT_ID` `ZOHO_CLIENT_SECRET` `MS_CLIENT_ID` `MS_CLIENT_SECRET` `MS_TENANT_ID` |
| 16 | `LINEAR_API_KEY` · `LINEAR_TEAM_KEY` (optional — which team a new issue is created in. Needed only when the key can see more than one team; with exactly one, that one is used and this can stay unset) |
| 17 | an `EMBED`-tier model name — not defined by the source plan (gap #5) |
| 18 | `AUTONOMOUS_SEND_ENABLED` — **must not exist before this phase** |

## Model variables hold a FALLBACK LADDER

Every `*_MODEL_<TIER>` variable is a **comma-separated list, tried left to
right**, not a single name:

```
GEMINI_MODEL_REASON=gemini-3.7-flash,gemini-3.5-flash,gemini-flash-latest
GEMINI_MODEL_VISION=gemini-3.5-flash,gemini-3.7-flash,gemini-flash-latest
```

A single name still works — it is a ladder of one. Gemini free-tier quota is
per-model, so a rung that 429s costs one wasted call and the next rung serves.
End every ladder with a floating alias (`gemini-flash-latest`): pinned model
names get retired without notice.

Re-probe a ladder before trusting it — `bunx convex run debug:pingAI
'{"model":"gemini-3.5-flash"}'` hits one model directly.

## Assistant behaviour (2026-10-15 cleanup)

| Variable | Default | What it does |
|---|---|---|
| `MEETING_NUDGE_MINUTES` | `30` | Minutes before an event the "📅 X in 30 min" nudge fires. `0` turns nudges off. Checked every 5 min, 06:00–22:59 Lagos. |
| `OPENAI_API_KEY` | unset | Presence alone makes OpenAI a configured provider. |
| `OPENAI_MODEL_REASON` / `_DRAFT` / `_CHEAP_STRUCTURED` | unset | Fallback ladders, like Gemini's. Keep to models in OpenAI's free daily tier (see `docs/RUNBOOK-cleanup.md`). |
| `AI_PROVIDER_PRIORITY` | `gemini` | e.g. `openai,gemini` — first configured provider wins; the next is the fallback. |
| `AI_ROUTE_<TASK>` | unset | Pin one task to one provider, e.g. `AI_ROUTE_CLASSIFY_IMPORTANCE=gemini`, `AI_ROUTE_TRANSCRIBE_VOICE=gemini`. |

`PLAN_TOOLS` now runs on the **REASON** tier (it was CHEAP_STRUCTURED): the
planner is the assistant's whole brain, and the cheap tier was why it answered
"when did this come in?" with a search. `SUMMARIZE_CONVERSATION` is new and
runs on CHEAP_STRUCTURED.

## Never an environment variable

Per-mailbox OAuth **refresh tokens** (Gmail, Zoho, Outlook). They are encrypted
with `ENCRYPTION_KEY` and stored in `connectedAccounts.encryptedCredentials`.

No Google service-account **private key** is used anywhere in this project.
`GOOGLE_PUBSUB_SA_EMAIL` is an identifier for verifying the push JWT's `email`
claim — not a credential.
