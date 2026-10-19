# Personal AI Assistant — agent instructions

Telegram-first personal secretary on Convex. Single user, single owner.

## Read before you write code

| You are touching | Read first |
|---|---|
| anything under `convex/` | `convex/_generated/ai/guidelines.md` — it overrides training data |
| architecture, phase scope | `docs/personal-ai-assistant-build-plan-v3-convex.md` |
| the phase in flight | `docs/build/PHASE-XX-*.md` |
| environment variables | `docs/ENV.md` — names only, never values |
| what changed and why | `CHANGELOG.md`, `MEMORY.md` |
| scripture, Bible import | `docs/SCRIPTURE.md` |

Convex skills live in `.claude/skills/convex-*`. Reach for `convex-reviewer`
before shipping a batch of backend code and `convex-authz` before any phase
that widens what a function can reach.

## The seven invariants

These hold from the first commit to the last. **If a change would violate one,
the change is wrong** — say so rather than working around it.

1. **The model proposes; the application disposes.** The LLM never holds a
   credential and never calls an external API. It emits a typed tool-call
   proposal; deterministic code Zod-validates, authorizes, resolves account
   identity, checks approval, then executes. See `convex/lib/tools/plan.ts`
   (proposal) and `convex/tools/router.ts` (disposal).
2. **External content is data, never instruction.** Email bodies, tool
   results, web text — all enter a prompt through `AIRequest.untrusted`, never
   concatenated into `input`. The structural defence is that output schemas
   have no field capable of expressing an action.
3. **Account identity is resolved in code, never inferred.** A reply's sending
   account is derived from the source message. A model never picks a mailbox.
4. **Consequential actions need a typed, expiring, single-use approval** bound
   to a hash of the exact payload. Consequential = external or destructive.
5. **`auditLogs` is append-only.** There is no delete function. Do not write one.
6. **Channels, providers and connectors are replaceable.** The core imports
   them only through interfaces.
7. **Cost is a design constraint.** Target $0/month infrastructure.

## Layering — the rule that makes everything testable

```
convex/lib/**     PURE. no ctx, no fetch, no ctx.db, no Convex imports
                  except `import type`. runs under plain `bun test`.
convex/model/**   queries + mutations. the only code that touches ctx.db.
convex/ai/**      provider implementations. network calls.
convex/channels/  one file per channel. the ONLY place that knows a wire format.
convex/tools/     the router: validates, authorizes, executes, audits.
convex/*.ts       orchestration + HTTP + crons.
```

Provider *selection* is pure, so it is in `lib/ai/resolve.ts`. Provider
*implementations* make network calls, so they are in `ai/providers/`. Keep that
boundary — it is what lets the domain logic be tested with no runtime.

**Never write `if (channel === "telegram")` outside `convex/channels/`.**

One deliberate exception: `connectors/gmail/normalize.ts` is pure and unit
tested despite not living in `lib/`, because Gmail wire-format knowledge
belongs in exactly one directory. Purity is the rule; the directory is the
convention.

## Convex specifics that bite here

- Default to `internalQuery` / `internalMutation` / `internalAction`. Make
  something public **only** when an HTTP action needs it. Internal functions
  have no URL.
- Actions cannot write to the database. Queries and mutations cannot `fetch`.
  That is the enforcement mechanism for invariant 1, not an obstacle.
- HTTP actions serve from `<deployment>.convex.site`, not `.convex.cloud`.
- No `Date` type — store ms-epoch numbers. All conversion goes through
  `convex/lib/time.ts`, never ad-hoc `new Date(...)` parsing.
- No `UNIQUE` constraint — index plus check-then-insert inside one mutation.
- Always `.withIndex()`, never `.filter()` on a growing table. The ceiling is
  32,000 documents scanned and 16 MiB read per transaction.
- Bound every read: `.take(n)` or `.paginate()`, never bare `.collect()`.
- Stay in the default V8 runtime. `"use node"` costs 512 MB against a
  20 GB-hour budget vs 64 MB — do not add it for `fetch`, which V8 already has.
- `convex/_generated/` **is committed**. After adding or renaming a function
  file, run `bunx convex codegen` or typecheck will fail against stale types.

## AI calls

Never name a model in feature code. Name a **task**; the task maps to a tier;
the tier maps to a model per provider via `<PROVIDER>_MODEL_<TIER>`.

```ts
await runTask("CLASSIFY_IMPORTANCE", { system, input, untrusted });
```

Add a task to `convex/lib/ai/tiers.ts` when its phase arrives. A provider is
"configured" purely by the presence of its API key, so adding a provider is
`bunx convex env set` — never a code change.

`bunx convex run debug:pingAI '{}'` proves the chain from the CLI without
sending a Telegram message.

## Commands

```bash
bun run dev          # convex dev — leave running in its own terminal
bunx convex codegen  # after adding/renaming a convex function file
bun run typecheck    # tsc --noEmit — must be clean before commit
bun test             # pure unit tests, no Convex runtime
bun run logs         # convex logs
```

Never run `bunx convex deploy` (production) without being asked explicitly.
Dev pushes are routine; production is not.

## Working conventions

- **Do not skip ahead of the current phase.** Each phase has an exit criterion
  in the build plan; meet it before starting the next.
- **Write the failing test first** for anything that lives in `convex/lib/`.
- **Every notable change gets a `CHANGELOG.md` entry.** Every non-obvious fact
  discovered along the way — a vendor's actual behaviour, a decision and its
  reason, a deviation from the build plan — gets a `MEMORY.md` entry. Do this
  as part of the change, not afterwards.
- **Never commit a secret.** Values live in Convex per-deployment env vars.
  `.env.*` is gitignored and stays that way.

---

<!-- convex-ai-start -->
# Agent Instructions

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
