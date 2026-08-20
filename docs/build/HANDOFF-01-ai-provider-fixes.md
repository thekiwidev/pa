# Handoff — AI provider layer fixes and open problems

**Date:** 20 Aug 2026
**Repo:** `~/work/me/pa` (personal-ai-assistant)
**Branch:** `main` · last commit `d457315` "Phase 0: Convex scaffold, schema, health check"
**Status of work below:** applied to the working tree, **not committed**

**Context for whoever picks this up:**
- Architecture source of truth → `docs/Personal AI Assistant — Build Plan v3 (Convex).md`
- Step-by-step build docs → `docs/build/`
- The narrative version of this report → `docs/build/FIX-01-gemini-only-and-model-fallback.md`

---

## 1. What broke, and why the first diagnosis was wrong

The bot returned this on every message:

```
All providers failed for task PLAN_TOOLS. Last error:
RetriableProviderError: anthropic returned 400: credit balance is too low
```

**Anthropic was not the cause.** The provider chain is `gemini → openai → anthropic`, and `runTask` reported only `lastError`. Gemini failed first, silently. The user has no Anthropic or OpenAI credit by design — Gemini is the only funded provider — so the message pointed at the last domino instead of the first.

Confirmed from `bunx convex logs`:

```
[WARN] ai_attempt_failed task=PLAN_TOOLS provider=gemini model=gemini-3.6-flash:
  gemini returned 429: "You exceeded your current quota..."
```

**Root cause: Gemini free-tier quota exhausted on `gemini-3.6-flash`.** Everything downstream was a consequence.

---

## 2. Changes made

### 2.1 `convex/ai/registry.ts` — aggregate every failure

`runTask` collected only `lastError`. It now accumulates a `failures: string[]` and throws with all of them:

```
All providers failed for task PLAN_TOOLS:
  gemini/gemini-3.6-flash: gemini returned 429: quota exceeded...
  openai/o4-mini: openai returned 429: insufficient_quota
  anthropic/claude-3-7-sonnet-latest: anthropic returned 400: credit balance too low
```

Also added a per-attempt `console.warn` tagged `ai_attempt_failed` with task, provider, and model, so failures are greppable in `convex logs` even when a later attempt succeeds.

**Behaviour change worth knowing:** the inner loop now continues past *any* error, not just `RetriableProviderError`. A fatal error on one model no longer aborts the chain — it is recorded and the next model is tried. Rationale: a bad model name or an unsupported request field is model-specific, and one typo should not take out the whole provider. Every failure still surfaces in the final aggregate message, so nothing is swallowed.

### 2.2 `convex/lib/ai/tiers.ts` — model fallback chains

New pure export:

```ts
export function modelChain(
  providerId: string,
  tier: Tier,
  env: Record<string, string | undefined>,
): string[]
```

Model env vars are now **comma-separated, tried left to right**:

```
GEMINI_MODEL_REASON=gemini-3.5-flash,gemini-2.5-flash
```

A single name still works — it is a chain of one. Backward compatible.

### 2.3 `convex/http.ts` — stop dropping non-text messages

`parseTextMessage` returns `null` for any update without a `text` field. The handler returned `200` and did nothing, so a voice note produced **total silence** — indistinguishable from a crash.

Added `parseUnsupportedMessage(update)`, which detects `voice · audio · photo · document · video · video_note · sticker` and schedules a reply. Still owner-guarded: a non-owner's voice note gets nothing.

### 2.4 `convex/assistant.ts` — `handleUnsupported` action

New `internalAction({ chatId, kind })` that sends a one-line explanation per kind, e.g. *"I can't listen to voice notes yet — that's Phase 9. Send it as text for now."*

### 2.5 `tests/unit/model-chain.test.ts` — new

Five cases for `modelChain` and `modelEnvVar`: ordering, whitespace/trailing-comma tolerance, single model, unset. Pure — no Convex runtime.

### 2.6 Configuration (run by the user, not code)

```bash
bunx convex env set GEMINI_MODEL_REASON            "gemini-3.5-flash,gemini-2.5-flash"
bunx convex env set GEMINI_MODEL_DRAFT             "gemini-3.5-flash,gemini-2.5-flash"
bunx convex env set GEMINI_MODEL_CHEAP_STRUCTURED  "gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash"
bunx convex env set GEMINI_MODEL_TRANSCRIBE        "gemini-3.5-flash,gemini-2.5-flash"
bunx convex env set AI_PROVIDER_PRIORITY           "gemini"
bunx convex env remove OPENAI_API_KEY
bunx convex env remove ANTHROPIC_API_KEY
# repeat with --prod
```

`3.6-flash` was dropped, not demoted — its quota is exhausted, and leaving it at the head meant every message burned a guaranteed-429 call before doing real work.

Removing the API keys is what removes the providers: `resolve.ts` treats key presence as "configured".

**Env vars need no redeploy** — they are read from `process.env` at invocation.

---

## 3. Files touched

| File | Change | Lines |
|---|---|---|
| `convex/ai/registry.ts` | edited — error aggregation, model-chain loop | 78 |
| `convex/lib/ai/tiers.ts` | edited — added `modelChain` | 52 |
| `convex/http.ts` | edited — `parseUnsupportedMessage` + dispatch | 162 |
| `convex/assistant.ts` | edited — added `handleUnsupported` | 291 |
| `tests/unit/model-chain.test.ts` | **new** | 31 |
| `docs/build/FIX-01-gemini-only-and-model-fallback.md` | **new** — narrative writeup | — |
| `docs/build/PHASE-01-telegram-ai-loop.md` | **new** — Phase 1 build doc | — |

Not touched: every other file under `convex/`. The provider implementations, `resolve.ts`, `errors.ts`, `prompt.ts`, the tool router, and all `model/*` files are unchanged.

---

## 4. Goals — what should now be true

**Verified by the change:**

1. A provider failure names every attempt, not just the last. No more chasing the wrong vendor.
2. `ai_attempt_failed` is greppable in `convex logs`, including for attempts that a later fallback rescued.
3. A voice note gets a reply instead of silence.
4. Model fallback is config, not code — changing the ladder is an `env set`.

**Expected but unconfirmed at time of writing:**

5. With `3.5-flash` first, the common path succeeds on the first attempt with no wasted 429.
6. If per-model quota buckets are separate, `2.5-flash` catches the case where `3.5-flash` is also exhausted.

**Acceptance test:**

```bash
bun test          # all green, including 5 new model-chain cases
bun run typecheck # clean
bunx convex deploy
# message the bot, then:
bunx convex logs | grep -E "ai_attempt_failed|handleMessage"
```

Green = a reply arrives with no `ai_attempt_failed` warnings.

---

## 5. Problems to escalate

### P1 — Quota burn rate. Likely the real bug. *(high)*

Every inbound message costs **two `REASON`-tier calls**: `PLAN_TOOLS` to choose tools, then a compose call for the reply. `gemini.ts` runs `REASON` at `thinkingLevel: "high"` with a 4096-token thinking reserve. So "are you there?" costs the same as a genuine planning problem.

The fallback ladder is a mitigation, not a fix. If Gemini's free-tier limits turn out to be project-wide rather than per-model, the ladder buys nothing.

Three independent reductions, roughly multiplicative:

- **Skip `PLAN_TOOLS` for plain conversation.** A deterministic pre-check in `convex/lib/` — no imperative verb, no entity match, short — routes straight to compose. Pure function, unit-testable, no model call.
- **Move `PLAN_TOOLS` to `CHEAP_STRUCTURED`.** It emits a structured tool proposal, not prose. That is what the tier is for, and it moves the call to the Flash-Lite quota.
- **Drop `REASON` to `thinkingLevel: "low"`.** The existing comment in `gemini.ts` already notes `"low"` is a real amount of thinking. Selecting a tool from a fixed catalogue is not a hard reasoning problem.

**Open question blocking prioritisation:** are Gemini free-tier limits per-model or per-project? [Google's rate-limits page](https://ai.google.dev/gemini-api/docs/rate-limits) says limits apply per project but does not state whether each model has its own bucket. The empirical test is one message: if `3.5-flash` answers while `3.6-flash` is 429ing, buckets are separate.

### P2 — Nothing is committed. *(high)*

All of Phase 1 and Phase 2 is uncommitted — 30+ untracked files including the entire `convex/ai/`, `convex/tools/`, `convex/model/`, and six test files. `git log` shows one commit, `d457315`, which is the Phase 0 scaffold only.

One `git checkout .` or a bad `git rm --cached` destroys days of work. **Commit before any further change.**

### P3 — No quota-exhaustion UX. *(medium)*

When the chain is exhausted the user sees a raw stack-trace-flavoured dump, truncated mid-JSON by Telegram's message limit. It should be caught in `assistant.ts` and rendered as a sentence — *"I'm out of AI quota for now, try again in a few minutes"* — with the detail left in the logs.

Related: Appendix C #14 ("provider returns 429 → fails over → logs it") is still unwritten. It is the adversarial test that covers this whole class and would have caught the last-error-only reporting.

### P4 — `TRANSCRIBE` tier is configured but unimplemented. *(medium)*

`GEMINI_MODEL_TRANSCRIBE` is set and `TASKS.TRANSCRIBE_VOICE` exists, but nothing calls it. Voice currently hits `handleUnsupported`.

Two verified facts for whoever builds Phase 9:

- **Telegram will not transcribe.** The Bot API delivers a `voice` object with a `file_id` and no text. Telegram's transcription is a Premium *client* feature over MTProto; bots never receive it.
- **The dedicated Gemini audio models are unusable here.** `gemini-2.5-flash-native-audio-*`, `gemini-3.1-flash-live-preview`, and `gemini-3.5-live-translate-preview` all expose `bidiGenerateContent` only — Live API over websockets, not request/response. Use an ordinary multimodal Flash model with the audio inlined:

```json
{"contents":[{"parts":[
  {"text":"Transcribe this audio verbatim. Output only the transcript."},
  {"inlineData":{"mimeType":"audio/ogg","data":"<base64>"}}
]}]}
```

`audio/ogg` is supported; inline payloads cap at 20 MB total.

**Unverified risk:** Google documents `audio/ogg` as *Vorbis*. Telegram voice notes are *Opus* in an Ogg container. This usually works but has not been tested here. If rejected, fall back to the File API rather than transcoding — transcoding would force a `"use node"` action, which costs 512 MB against a 20 GB-hour monthly budget versus 64 MB in V8.

### P5 — `REQUIRED_NOW` may be stale. *(low)*

`convex/lib/config.ts` drives `/health`'s `configOk`. Phase 2 added tables and env dependencies; if the list was not extended, `/health` reports green on a deployment that is missing variables. Worth an audit against what Phase 2 actually reads.

### P6 — Stale provider config on disk. *(low)*

`.env.dev` and `.env.prod` still contain `OPENAI_MODEL_*` and `ANTHROPIC_MODEL_*` lines. Harmless once the API keys are removed, but the files now misrepresent what is configured. Delete those lines.

Also unverified: `o4-mini` and `claude-3-7-sonnet-latest` were never checked against a live model list. Moot while both providers are removed — relevant if either is ever re-enabled.

---

## 6. Suggested order

1. **Commit.** (P2)
2. Run the env commands, deploy, message the bot.
3. Read the logs and settle the per-model-vs-per-project quota question. (P1)
4. If project-wide → do the three routing reductions. If per-model → deprioritise.
5. Wrap the exhaustion path in a human message. (P3)
6. Write Appendix C #14. (P3)
7. Clean the env files. (P6)
8. Phase 9 transcription, or Phase 3 Gmail — user's call. (P4)
