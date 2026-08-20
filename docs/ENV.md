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
`APPROVAL_TTL_MINUTES` · `MAX_ALERTS_PER_HOUR` · `ZOHO_*` · `MS_*` · `LINEAR_API_KEY`

## First consumed by phase

| Phase | Variables |
|---|---|
| 0 | `ENCRYPTION_KEY` |
| 1 | `TELEGRAM_BOT_TOKEN` `TELEGRAM_WEBHOOK_SECRET` `TELEGRAM_OWNER_ID` `AI_PROVIDER_PRIORITY` `GEMINI_API_KEY` `GEMINI_MODEL_CHEAP_STRUCTURED` `GEMINI_MODEL_REASON` `GEMINI_MODEL_DRAFT` |
| 2 | `USER_TIMEZONE` |
| 3 | `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_REDIRECT_URI` |
| 5 | `MAX_ALERTS_PER_HOUR` |
| 6 | `APPROVAL_TTL_MINUTES` |
| 8 | `GOOGLE_PUBSUB_TOPIC` `GOOGLE_PUBSUB_AUDIENCE` `GOOGLE_PUBSUB_SA_EMAIL` |
| 9 | `GEMINI_MODEL_TRANSCRIBE` (+ optional `OPENAI_*`, `AI_ROUTE_TRANSCRIBE_VOICE`) |
| 15 | `ZOHO_CLIENT_ID` `ZOHO_CLIENT_SECRET` `MS_CLIENT_ID` `MS_CLIENT_SECRET` `MS_TENANT_ID` |
| 16 | `LINEAR_API_KEY` |
| 17 | an `EMBED`-tier model name — not defined by the source plan (gap #5) |
| 18 | `AUTONOMOUS_SEND_ENABLED` — **must not exist before this phase** |

## Model variables hold a FALLBACK LADDER

Every `*_MODEL_<TIER>` variable is a **comma-separated list, tried left to
right**, not a single name:

```
GEMINI_MODEL_REASON=gemini-3.7-flash,gemini-3.5-flash,gemini-flash-latest
```

A single name still works — it is a ladder of one. Gemini free-tier quota is
per-model, so a rung that 429s costs one wasted call and the next rung serves.
End every ladder with a floating alias (`gemini-flash-latest`): pinned model
names get retired without notice.

Re-probe a ladder before trusting it — `bunx convex run debug:pingAI
'{"model":"gemini-3.5-flash"}'` hits one model directly.

## Never an environment variable

Per-mailbox OAuth **refresh tokens** (Gmail, Zoho, Outlook). They are encrypted
with `ENCRYPTION_KEY` and stored in `connectedAccounts.encryptedCredentials`.

No Google service-account **private key** is used anywhere in this project.
`GOOGLE_PUBSUB_SA_EMAIL` is an identifier for verifying the push JWT's `email`
claim — not a credential.
