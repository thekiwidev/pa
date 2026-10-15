# Personal AI Assistant

A Telegram-first personal secretary built on Convex. Single user, single
owner, $0/month infrastructure.

You text it like a person. It manages your projects, tasks, blockers and
reminders; reads and classifies three Gmail mailboxes; drafts replies you
approve with a tap; keeps notes in Notion; updates Linear; extracts
commitments from meeting transcripts; and sends you a morning brief. It reads
voice notes, photos, PDFs and text files.

It never sends anything, and never changes anything outside itself, without an
explicit approval bound to the exact payload.

---

## Start here

| If you want to… | Read |
| --- | --- |
| **See how a message actually flows, as diagrams** | **[`docs/FLOWCHART.md`](docs/FLOWCHART.md)** |
| **Know where the project stands against the plan** | **[`docs/STATUS.md`](docs/STATUS.md)** |
| Understand *why* it is built this way | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Find the file that does the thing you want to change | [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) |
| Verify a change | [`docs/TESTING.md`](docs/TESTING.md) |
| Ship to dev or production | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| Know what env var does what | [`docs/ENV.md`](docs/ENV.md) |
| Know what to build next | [`docs/STATUS.md`](docs/STATUS.md) — ROADMAP.md is superseded |
| Know what we are *thinking* of doing | [`docs/NOTES.md`](docs/NOTES.md) |
| Know why something is the way it is | [`MEMORY.md`](MEMORY.md) — the most useful file here |
| Know what changed | [`CHANGELOG.md`](CHANGELOG.md) |

Rules that bind both humans and agents working in this repo:
[`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md).

---

## Quick start

```bash
bun install
git config core.hooksPath .githooks     # enables the gitleaks pre-commit hook

bunx convex dev                          # creates/links the dev deployment
bunx convex env set --from-file .env.dev
./scripts/register-telegram-webhook.sh dev

bunx convex run debug:pingAI '{}'        # prove the AI chain before Telegram
```

Then message the dev bot: `/status`, `/help`.

Full first-time setup, including production: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Commands

```bash
bun run dev              # convex dev — leave running in its own terminal
bun run typecheck        # tsc --noEmit — must be clean before commit
bun test                 # pure unit tests, no Convex runtime, ~1s
bunx convex codegen      # after adding or renaming a convex function file
bun run logs             # convex logs
bun run dashboard        # convex dashboard
bun run deploy           # convex deploy — PRODUCTION, a deliberate act only

bunx convex run debug:pingAI   '{}'                  # which provider answered?
bunx convex run debug:planOnly '{"text":"..."}'      # what did the model propose?
```

---

## Stack

TypeScript (strict) · Bun · **Convex** — database, functions, HTTP, cron,
scheduler, file storage, vector search, all one system · Zod for the tool
contract and LLM structured output · Telegram Bot API over plain `fetch`, no
framework.

**Models:** Gemini today; OpenAI, Anthropic and OpenRouter supported. A
provider is "configured" purely by the presence of its API key, so switching
vendors is `bunx convex env set` — never a code change. See
[`HOW-IT-WORKS.md` §3.5](docs/HOW-IT-WORKS.md).

**Connectors:** Gmail (OAuth, encrypted refresh tokens), Notion (notes),
Linear (issues), and read-only social post fetching for links you paste.

---

## How a message flows

```plaintext
Telegram → http.ts        verify secret · owner-only · ack in ms · schedule
         → assistant.ts   gather context → build prompt → PLAN (model)
         → plan.ts        Zod-validate the proposal; drop what fails
         → router.ts      approval gate → resolve names → execute → audit
         → outcomes.ts    render the result deterministically  ← the default reply
         → assistant.ts   COMPOSE (model) only if a skill matched
         → telegram.ts    markdown → HTML → split → send
```

One model call for an ordinary turn. Two when a skill matches. Three at most.
There is no agent loop.

Full walkthrough with file and function names:
[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).

---

## Layout

```files
convex/
  http.ts          httpRouter — Telegram webhook, Google OAuth, /health
  assistant.ts     THE ORCHESTRATOR. the only file that decides what happens
  crons.ts         recurring jobs. EXPRESSIONS ARE UTC (Lagos = UTC+1)
  schema.ts        one file, the whole data model
  gmail.ts         sync, deep search, classification, send
  briefs.ts        the morning brief
  reminders.ts     scheduled delivery + the hourly reconcile sweep
  meetings.ts      transcript ingestion
  notify.ts        notification cards
  debug.ts         operator tools — pingAI, planOnly, recentAudit, …

  lib/             PURE. no ctx, no I/O. the brain. unit-tested.
    ai/              tiers, provider resolution, untrusted framing, errors
    tools/           the catalog (Zod), the proposal parser, the renderer
    prompts/         prompt construction — assistant, format, knowledge
    email/           classification, prefilter, rules, recipients, draft body
    telegram/        html, richtext, message splitting
    skills.ts        default procedures + keyword relevance
    scope.ts         the deterministic guard against fabricated claims
    time.ts          ms-epoch ↔ wall clock in USER_TIMEZONE

  model/           queries + mutations, grouped by entity. the only ctx.db code
  ai/              provider registry + one file per vendor
  tools/router.ts  validate → authorize → execute → audit
  channels/        telegram adapter — the ONLY place that knows a wire format
  connectors/      gmail, notion, linear, social
  security/        AES-256-GCM (crypto.ts) + SHA-256 payload binding (hash.ts)

tests/
  unit/            32 files, 548 tests, ~250ms. no Convex runtime
  adversarial/     the invariants, as executable tests
```

---

## The seven invariants

If a change would violate one, the change is wrong. Say so rather than working
around it. Reasoning for each is in
[`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md).

1. **The model proposes; the application disposes.** The LLM never holds a
   credential and never calls an external API. Convex enforces this: queries
   and mutations cannot `fetch`; actions cannot write to the database.
2. **External content is data, never instruction.** Email bodies, tool results
   and web text enter through a labelled `untrusted` block. The structural
   defence is that those tasks' output schemas have no field capable of
   expressing an action.
3. **Account identity is resolved in code, never inferred.** A reply's sending
   account comes from the source message. A model never picks a mailbox.
4. **Consequential actions need a typed, expiring, single-use approval** bound
   to a hash of the exact payload, recomputed from the live record at send
   time.
5. **`auditLogs` is append-only.** There is no delete function. Do not write one.
6. **Channels, providers and connectors are replaceable.** The core imports
   them only through interfaces.
7. **Cost is a design constraint.** $0/month infrastructure.

Two standing consequences: **no hard-delete tool for email** — trash only —
and **never fetch a URL found inside an email**.

---

## The layering rule

```plaintext
convex/lib/**     PURE. no ctx, no fetch, no ctx.db, no Convex imports
                  except `import type`. runs under plain `bun test`.
convex/model/**   queries + mutations. the only code that touches ctx.db.
convex/ai/**      provider implementations. network calls.
convex/channels/  one file per channel. the ONLY place that knows a wire format.
convex/tools/     the router: validates, authorizes, executes, audits.
convex/*.ts       orchestration + HTTP + crons.
```

The boundary is drawn at **I/O**, not at subject matter. Provider *selection*
is pure, so it is in `lib/ai/resolve.ts`; provider *implementations* make
network calls, so they are in `ai/providers/`. That split is what lets the
whole domain be tested in a second with no runtime and no mocks.

**Never write `if (channel === "telegram")` outside `convex/channels/`.**

---

## AI calls

Never name a model in feature code. Name a **task**; the task maps to a tier;
the tier maps to a model per provider via `<PROVIDER>_MODEL_<TIER>`.

```ts
await runTask("CLASSIFY_IMPORTANCE", { system, input, untrusted });
```

Each `*_MODEL_<TIER>` variable holds a **comma-separated fallback ladder**
tried left to right, ending in a floating alias — pinned model names get
retired without notice, and free-tier quota is per-model.

```env
GEMINI_MODEL_REASON=gemini-3.7-flash,gemini-3.5-flash,gemini-flash-latest
```

Prove the chain without sending a Telegram message:

```bash
bunx convex run debug:pingAI '{}'
```

---

## Convex specifics that bite here

- Default to `internalQuery` / `internalMutation` / `internalAction`. Make
  something public **only** when an HTTP action needs it — internal functions
  have no URL.
- HTTP actions serve from `<deployment>.convex.site`, **not** `.convex.cloud`.
- No `Date` type — store ms-epoch numbers. All conversion goes through
  `convex/lib/time.ts`, never ad-hoc `new Date(...)` parsing.
- No `UNIQUE` constraint — index plus check-then-insert inside one mutation
  (mutations are ACID transactions, so that is genuinely atomic).
- Always `.withIndex()`, never `.filter()` on a growing table. The ceiling is
  32,000 documents scanned and 16 MiB read per transaction.
- Bound every read: `.take(n)` or `.paginate()`, never bare `.collect()`.
- Stay in the default V8 runtime. `"use node"` costs 512 MB against a
  20 GB-hour budget vs 64 MB — do not add it for `fetch`, which V8 already has.
- `convex/_generated/` **is committed**. After adding or renaming a function
  file, run `bunx convex codegen` or typecheck fails against stale types.
- Cron expressions are **UTC**. Lagos is UTC+1, no DST — 07:00 local is
  `0 6 * * *`.

---

## Working conventions

- **Write the failing test first** for anything in `convex/lib/`.
- **Every notable change gets a `CHANGELOG.md` entry.** Every non-obvious fact
  discovered along the way — a vendor's actual behaviour, a decision and its
  reason, a deviation from the plan — gets a `MEMORY.md` entry. As part of the
  change, not afterwards.
- **Never commit a secret.** Values live in Convex per-deployment env vars.
  `.env.*` is gitignored and stays that way.
- **Verify against the live dev deployment**, not just `bun test`. Unit tests
  cover pure modules; the router is not pure, and two real bugs lived in
  exactly that gap.
- **Dev pushes are routine; `bunx convex deploy` is not.**

---

## Status

**Built and live:** the Telegram loop (text, voice, images, albums,
documents) · the AI provider chain with per-tier model ladders · projects,
tasks, blockers, reminders, people · Gmail OAuth with encrypted credentials,
sync, search, deep search · importance classification · draft / approve / send
· three-mailbox routing · Notion notes · Linear changesets · meeting
transcripts · morning brief · skills, standing instructions, user context.

**60 tools · 15 commands · 5 cron jobs.**

**Next up and what blocks it:** [`docs/STATUS.md`](docs/STATUS.md).
