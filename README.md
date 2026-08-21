# personal-ai-assistant

Telegram-first personal AI secretary on Convex.

- **What's built, what's next:** `docs/ROADMAP.md`
- **Architecture / source of truth:** `docs/personal-ai-assistant-build-plan-v3-convex.md`
- **Current phase build doc:** `docs/build/`
- **Env variable names:** `docs/ENV.md`
- **What changed:** `CHANGELOG.md` · **Why, and what bit us:** `MEMORY.md`
- **Rules for agents (and humans):** `CLAUDE.md` / `AGENTS.md`

**Status:** Phases 0–3 complete (plus voice, skills, deep search). Eleven
phases documented and unbuilt — see `docs/ROADMAP.md` for order and blockers.

## Stack

TypeScript (strict) · Bun · Convex (database, functions, HTTP, cron, scheduler,
file storage, vector search) · Zod for LLM structured output · Telegram Bot API.

## Commands

```bash
bun install
bun run dev              # convex dev — leave running in its own terminal
bunx convex codegen      # after adding or renaming a convex function file
bun run typecheck        # tsc --noEmit
bun test                 # unit tests against convex/lib/ — no Convex runtime
bun run logs             # convex logs
bun run dashboard        # convex dashboard
bun run deploy           # convex deploy (PRODUCTION — deliberate act only)

bunx convex run debug:pingAI '{}'   # prove the AI provider chain from the CLI
```

## Layout

```
convex/
  schema.ts        one file, the whole data model (Appendix F of the plan)
  http.ts          httpRouter — /health now; webhooks + OAuth later
  crons.ts         recurring jobs. EXPRESSIONS ARE UTC (Lagos = UTC+1)
  assistant.ts     the orchestrator. the only file that decides what happens.
  reminders.ts     scheduled delivery + the hourly reconcile sweep
  debug.ts         internal operator tools (pingAI)
  lib/             PURE functions. no ctx, no I/O. the brain. unit-tested.
    ai/            tiers, provider resolution, error classification
    tools/         tool catalog (Zod) + proposal parser
    prompts/       prompt construction
    time.ts        ms-epoch <-> wall clock in USER_TIMEZONE
  model/           queries + mutations, grouped by entity
  ai/              provider registry (tier -> provider -> model) + providers
  tools/           the router: validate, authorize, execute, audit
  channels/        telegram adapter
  connectors/      gmail, later zoho
  security/        AES-256-GCM via Web Crypto
tests/
  unit/            runs with no Convex runtime
  integration/
  adversarial/     25 cases from Appendix C of the plan
```

## Rules that do not bend

1. **The model proposes; the application disposes.** Convex enforces this:
   queries/mutations cannot `fetch`; actions cannot write to the database.
2. **Email content is data, never instruction.** External text enters prompts
   only inside a labelled untrusted block, and the classifier's output schema
   cannot express an action.
3. **The sending account is resolved in code, never inferred by a model.**
4. **Consequential actions need a hash-bound, expiring, single-use approval.**
5. **`auditLogs` is append-only.** No delete function exists. Do not write one.
6. **No hard-delete tool for email.** Trash only.
7. **Never fetch a URL found inside an email.**

## Convex specifics that bite

- HTTP actions serve from `<deployment>.convex.site`, not `.convex.cloud`.
- No `Date` type — store ms-epoch numbers, format at the edge.
- No `UNIQUE` constraint — index + check-then-insert in one mutation.
- Never `.filter()` on a growing table; always `.withIndex()`.
  Limits are 32,000 documents scanned and 16 MiB read per transaction.
- Stay in the default V8 runtime. `"use node"` costs 512 MB against a
  20 GB-hour monthly budget vs 64 MB in V8 — 8x less headroom.
- `convex/_generated/` **is committed**, per Convex docs, so the project
  type-checks without running `convex dev` first.
