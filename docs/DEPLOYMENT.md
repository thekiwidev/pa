# Deployment guide

Two environments exist today: **dev** and **production**. Dev *is* the staging
environment — it has its own Convex deployment, its own Telegram bot, its own
encryption key, and its own Gmail OAuth redirect. It is not a local emulator;
code pushed there runs on Convex's infrastructure exactly as production does.

That is the whole isolation story, and it is deliberate: two real deployments
that share nothing except your source code.

```view
┌── dev / staging ──────────────┐   ┌── production ─────────────────┐
│ deployment:  coordinated-owl… │   │ deployment: (its own)         │
│ bot:         @yourbot_dev     │   │ bot:        @yourbot          │
│ ENCRYPTION_KEY: key A         │   │ ENCRYPTION_KEY: key B         │
│ redirect: …-dev.convex.site   │   │ redirect: ….convex.site       │
│ push:  bun run dev (watch)    │   │ push:  bunx convex deploy     │
└───────────────────────────────┘   └───────────────────────────────┘
```

**Never share a Telegram bot between deployments.** A bot can hold exactly one
webhook URL; pointing the production bot at dev silently redirects your real
traffic.

---

## Part 1 · Deploying to dev (staging)

### Everyday loop

```bash
bun run dev
```

That is `convex dev` — it watches, type-checks, pushes on every save, and
streams logs. Leave it running in its own terminal all day. This is how 95% of
your deploys happen.

### One-shot push

For CI, or when you do not want a watcher:

```bash
bunx convex dev --once
```

### The full checklist

```bash
# 1. Green locally. Both. Neither catches what the other does.
bun test
bun run typecheck

# 2. If you added or renamed a file under convex/, regenerate types.
#    convex/_generated/ IS committed, so stale types fail typecheck.
bunx convex codegen

# 3. Push.
bunx convex dev --once

# 4. Prove the AI chain from the CLI, before touching Telegram.
bunx convex run debug:pingAI '{}'

# 5. Health.
curl -s https://<dev-deployment>.convex.site/health
# → {"status":"ok","configOk":true}

# 6. Smoke test in Telegram — see TESTING.md §7.
```

`configOk: false` means a variable in `REQUIRED_NOW`
([`convex/lib/config.ts`](../convex/lib/config.ts)) is missing. The endpoint
deliberately does **not** say which one; run `bunx convex env list` and diff.

### First-time dev setup

```bash
git clone <repo> && cd pa
bun install
git config core.hooksPath .githooks     # enables the gitleaks pre-commit hook
brew install gitleaks

bunx convex dev                          # creates/links the dev deployment,
                                         # writes .env.local
bunx convex env set --from-file .env.dev
bunx convex env list                     # verify

./scripts/register-telegram-webhook.sh dev
./scripts/register-telegram-webhook.sh dev --info
```

`.env.dev` and `.env.prod` are **gitignored** and hold the real values. The
committed [`docs/ENV.md`](ENV.md) holds names only.

### Changing an environment variable

Variables live on the deployment, not in the repo. Changing one takes effect
immediately — no redeploy.

```bash
bunx convex env set AI_PROVIDER_PRIORITY "openai,gemini"
bunx convex env list
bunx convex run debug:pingAI '{}'        # confirm it took
```

Update `.env.dev` too, or the next `--from-file` will revert you.

---

## Part 2 · Deploying to production

> **Production deploys are a deliberate act.** Dev pushes are routine;
> `bunx convex deploy` is not. Do not run it as a reflex, and never run it
> from a dirty working tree.

### Pre-flight

Everything in this list, in order. Stop at the first failure.

```bash
# 1. Clean tree, on main, everything committed
git status
git log --oneline -5

# 2. Green
bun test
bun run typecheck

# 3. Dev is running the exact code you are about to promote
bunx convex dev --once
bunx convex run debug:pingAI '{}'

# 4. The ten-message Telegram smoke test on the DEV bot — TESTING.md §7
#    Plus the adversarial cases. Do not skip 7 and 10.

# 5. Production env vars are complete and correct
bunx convex env list --prod
```

Check specifically that these **differ** between dev and prod. Sharing any one
of them is a real incident:

| Variable | Why it must differ |
| --- | --- |
| `ENCRYPTION_KEY` | separate key per deployment; both in your password manager |
| `TELEGRAM_BOT_TOKEN` | one bot per deployment |
| `TELEGRAM_WEBHOOK_SECRET` | one secret per bot |
| `GOOGLE_REDIRECT_URI` | different `.convex.site` domain |
| `GOOGLE_PUBSUB_TOPIC` | `gmail-push-dev` vs `gmail-push-prod` |

Everything else — `TELEGRAM_OWNER_ID`, `AI_PROVIDER_PRIORITY`, all
`*_API_KEY`, all `*_MODEL_*`, `USER_TIMEZONE`, `APPROVAL_TTL_MINUTES` — is
identical on both. Full table in [`docs/ENV.md`](ENV.md).

> **`ENCRYPTION_KEY` is not rotatable in place.** It decrypts every stored
> OAuth refresh token in `connectedAccounts.encryptedCredentials`. Changing it
> orphans every connected mailbox, and the only recovery is `/reconnect` for
> each one. Losing it has the same effect. Keep both keys in a password
> manager before you deploy anything.

### The deploy

```bash
# Push code + schema to production
bunx convex deploy

# Set/refresh production env vars if they changed
bunx convex env set --from-file .env.prod --prod
bunx convex env list --prod
```

### Post-deploy verification

```bash
# 1. Health
curl -s https://<prod-deployment>.convex.site/health
# → {"status":"ok","configOk":true}

# 2. AI chain, on production, from the CLI — before any Telegram traffic
bunx convex run --prod debug:pingAI '{}'

# 3. Crypto round-trip against the production key
bunx convex run --prod debug:cryptoSelfTest '{}'

# 4. Point the production bot at the production webhook
./scripts/register-telegram-webhook.sh prod
./scripts/register-telegram-webhook.sh prod --info
#    verify: url is the PROD .convex.site, pending_update_count is 0,
#            last_error_message is null

# 5. Connect the mailbox (first deploy only)
#    In Telegram: /connect personal → follow the link → /accounts

# 6. Smoke test on the PRODUCTION bot: /status, /help, /tasks,
#    one reminder, one inbox question.

# 7. Watch for ten minutes
bunx convex logs --prod
bunx convex run --prod debug:recentAudit '{}'
```

### Schema changes

Convex validates the schema on push. A change that existing documents violate
is **rejected at deploy time** — the deploy fails, production keeps running
the old code. That is the safe default, not an error to work around.

The safe sequence for a field that must become required:

1. Add it as `v.optional(...)`. Deploy.
2. Backfill existing rows (`@convex-dev/migrations`, or a one-off
   `internalMutation` you run and then delete).
3. Make it required. Deploy.

Rehearse anything larger against a preview deployment first — the
`convex-migrate-rehearse` skill in `.claude/skills/` covers seeding a preview
from a production snapshot.

### Rollback

There is no `convex rollback`. Roll back by deploying the previous commit:

```bash
git log --oneline -10
git checkout <last-good-sha>
bunx convex deploy
git checkout main            # do not leave yourself detached
```

Then fix forward on a branch. Note that this rolls back **code**, not
**data** — a schema change that already ran is still applied, and rows written
by the bad version are still there. Which is why the optional-first sequence
above matters.

If the failure is in a connector or a model rather than in your code, you can
usually stop the bleeding without a deploy at all:

```bash
bunx convex env set --prod AI_PROVIDER_PRIORITY "gemini"   # drop a bad provider
```

Env changes take effect immediately.

---

## Part 3 · Preview deployments (optional)

Convex can create a throwaway deployment per branch:

```bash
bunx convex deploy --preview-create my-branch-name
```

It gets its own database and its own env vars, and is destroyed when you are
done. Useful for rehearsing a migration or letting someone else poke at a
feature. It is **not** wired into this project's workflow today — there is no
CI and no hosting integration driving it. If you adopt it, remember a preview
deployment needs its own `TELEGRAM_BOT_TOKEN` to be reachable from Telegram at
all.

---

## Part 4 · Operations

### Watching

```bash
bun run logs                                 # dev
bunx convex logs --prod                      # production
bun run dashboard                            # the Convex dashboard
bunx convex run --prod debug:recentAudit '{}'
```

The dashboard is where you read `auditLogs` and `messages` directly, and where
Convex's own insights (slow functions, read-limit warnings, OCC contention)
live.

### Cost

Target is $0/month infrastructure — Convex's free tier, plus whatever the AI
providers cost. The design constraints that keep it there:

- **Stay in the default V8 runtime.** `"use node"` costs 512 MB per function
  against a 20 GB-hour monthly budget vs 64 MB — eight times less headroom,
  for a `fetch` that V8 already has.
- **Convex bills database bandwidth.** Bound every read (`.take(n)`), cap
  stored blobs (`emailMessages.bodyText` at 32 KB, meeting transcripts
  likewise), and never re-read a large field in a list query.
- **Model calls are the real cost.** One per ordinary turn, two when a skill
  matches, three at most. See [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) §1.

### Backups

Convex snapshots are available from the dashboard. Take one **before** any
schema change or migration you cannot trivially reverse — that snapshot is
your rollback for data, since a code rollback is not. The `convex-backup`
skill in `.claude/skills/` covers running an actual restore drill, which is
the only way to know a backup works.

---

## Part 5 · Failure playbook

| Symptom | First check | Fix |
| --- | --- | --- |
| `/health` returns `configOk: false` | `bunx convex env list --prod` | diff against `docs/ENV.md`, set what is missing |
| Bot silent after deploy | `./scripts/register-telegram-webhook.sh prod --info` | re-register; check `last_error_message` |
| Buttons spin forever | `allowed_updates` in `getWebhookInfo` | must include `callback_query` — re-run the register script |
| "I'm out of AI quota" | `debug:pingAI '{"model":"<name>"}'` per rung | add a rung to the ladder, or reorder `AI_PROVIDER_PRIORITY` |
| Mailbox shows `NEEDS_REAUTH` | `/accounts` | `/reconnect <label>` in Telegram |
| Every mailbox broke at once | did `ENCRYPTION_KEY` change? | restore the old key from the password manager, or `/reconnect` each |
| Deploy rejected on schema | the error names the field | make it optional, backfill, then require |
| Emails stopped arriving | `bunx convex logs --prod`, then `/sync` | check the cron ran; `syncAll` in `convex/gmail.ts` |
| Formatting arrives literal | `lib/telegram/richtext.ts` | convert to HTML *before* splitting at 4096 |

### Cron timing

Cron expressions are **UTC**. Lagos is UTC+1 with no DST, so 07:00 local is
`0 6 * * *`. Every line in [`convex/crons.ts`](../convex/crons.ts) carries the
offset in a comment. If a job fires an hour off, this is why.
