# Fix 01 — Gemini-only, model fallback chains, and the error that lied to you

Applied to your repo. Four code changes, one env change you run, one open question.

---

## What actually broke

The error you saw:

```
All providers failed for task PLAN_TOOLS. Last error:
RetriableProviderError: anthropic returned 400: credit balance is too low
```

**Anthropic was not the problem.** It was the last thing to fail, and the old registry only reported `lastError`. The chain is `gemini → openai → anthropic`, so by the time Anthropic was reached, **Gemini had already failed and you were never told why.**

The most likely cause is the Gemini free tier's rate limit — you'd been chatting for a while, and `PLAN_TOOLS` runs at the `REASON` tier which is the most expensive call in the loop. Gemini returns 429, which is retriable, so the chain fell through. OpenAI has no credits, returns 429 `insufficient_quota` — also retriable. Anthropic has no credits, returns 400 with a quota message, which `errors.ts` correctly classifies as retriable. Chain exhausted.

Every message failing afterwards fits: once you're rate-limited, you stay rate-limited for the window.

**Confirm it before trusting my reasoning** — the real Gemini error is sitting in your logs:

```bash
bunx convex logs | grep -i "ai_attempt_failed\|provider_failover\|gemini"
```

---

## Change 1 — The registry now reports every failure

**File:** `convex/ai/registry.ts`

Reporting only the last error is what turned a Gemini problem into an Anthropic red herring. It now collects each attempt and names them all:

```
All providers failed for task PLAN_TOOLS:
  gemini/gemini-3.6-flash: gemini returned 429: quota exceeded for model...
  openai/o4-mini: openai returned 429: insufficient_quota
  anthropic/claude-3-7-sonnet-latest: anthropic returned 400: credit balance is too low
```

That message tells you what to fix. The old one pointed at the wrong vendor.

---

## Change 2 — Model fallback chains

**Files:** `convex/lib/ai/tiers.ts` (new `modelChain`), `convex/ai/registry.ts`

A tier's model variable is now a **comma-separated chain**, tried left to right:

```
GEMINI_MODEL_REASON=gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash
```

If `3.6` rejects a request field, hits its own quota, or isn't on your key, you drop one generation instead of falling through to a vendor with no credits. This is exactly the "if 3.6 doesn't work try 3.5" behaviour you asked for, and it now happens automatically.

A single model name still works — it's a chain of one.

**Test:** `tests/unit/model-chain.test.ts` — 5 cases, no runtime needed.

---

## Change 3 — Voice notes no longer vanish

**Files:** `convex/http.ts`, `convex/assistant.ts`

`parseTextMessage` returns `null` for anything without a `text` field, and the handler returned `200` and did nothing. Your voice note hit that path — **total silence, indistinguishable from a crash.**

Now a voice, audio, photo, document, video, or sticker gets an honest one-liner:

> I can't listen to voice notes yet — that's Phase 9. Send it as text for now.

Still owner-guarded: a stranger's voice note gets nothing.

---

## Change 4 — Your model choices, against your own policy

Every tier was pointed at `gemini-3.6-flash`, including `TRANSCRIBE`.

From your CSV, the stable non-preview lineage is `3.7-flash` (current flagship, Aug 2026) → `3.6-flash` (Jul) → `3.5-flash` (May). Your rule is "two generations behind, always a fallback."

**Run this — it's the only manual step:**

```bash
# ── Point every tier at a chain, newest-acceptable first ──
bunx convex env set GEMINI_MODEL_REASON            "gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash"
bunx convex env set GEMINI_MODEL_DRAFT             "gemini-3.6-flash,gemini-3.5-flash,gemini-2.5-flash"
bunx convex env set GEMINI_MODEL_CHEAP_STRUCTURED  "gemini-3.5-flash-lite,gemini-2.5-flash-lite"
bunx convex env set GEMINI_MODEL_TRANSCRIBE        "gemini-3.5-flash,gemini-2.5-flash"

# ── Gemini only. Removing the keys is what removes the providers:
#    resolve.ts treats "key present" as "provider configured".
bunx convex env remove OPENAI_API_KEY
bunx convex env remove ANTHROPIC_API_KEY
bunx convex env set AI_PROVIDER_PRIORITY "gemini"

# ── Repeat all of the above with --prod ──
```

Also delete the `OPENAI_MODEL_*` and `ANTHROPIC_MODEL_*` lines from `.env.dev` and `.env.prod` so the files stop lying about what's configured.

**Why `3.5-flash-lite` for CHEAP_STRUCTURED:** that tier is classification and extraction — short structured answers where Flash-Lite is the right cost/latency point. It matters from Phase 4, when every incoming email hits it.

**On `o4-mini` and `claude-3-7-sonnet-latest`:** both were guesses, neither verified against a live model list. Moot now that both providers are removed, but worth knowing they were never checked.

---

## The open question: transcription

Two facts I verified rather than assumed.

**Telegram will not transcribe for you.** The Bot API delivers a `voice` object with a `file_id` and nothing else. Telegram's transcription is a Premium *client* feature over MTProto, not something bots receive. Every working Telegram voice bot downloads the file and transcribes it elsewhere.

**Gemini can, through the model you already use.** The dedicated audio models in your CSV are a dead end — `gemini-2.5-flash-native-audio-*`, `gemini-3.1-flash-live-preview`, and `gemini-3.5-live-translate-preview` all list `bidiGenerateContent` only. That's the Live API over websockets, for realtime conversation, not file transcription. You cannot call them with a plain POST.

What you want is the ordinary multimodal Flash model with the audio inlined:

```
POST /v1beta/models/gemini-3.5-flash:generateContent
{
  "contents": [{ "parts": [
    { "text": "Transcribe this audio verbatim. Output only the transcript." },
    { "inlineData": { "mimeType": "audio/ogg", "data": "<base64>" } }
  ]}]
}
```

`audio/ogg` is supported and inline data is capped at 20 MB total — a Telegram voice note is far under that.

**One caveat to test rather than trust:** Google documents `audio/ogg` as *Vorbis*, and Telegram voice notes are *Opus* in an Ogg container. It generally works, but it's the first thing to check when you build Phase 9. If it rejects the format, the fallback is the File API rather than inline.

**Phase 9 is three steps:** Telegram `getFile` → download → base64 → one `generateContent` call at the `TRANSCRIBE` tier → the existing text pipeline. Say the word and I'll write it in the Phase 1 doc format.

---

## Verify

```bash
bun test          # 20-ish, including 5 new model-chain cases
bun run typecheck
bunx convex deploy
```

Then message the bot. If it still fails, the aggregate error now names the real cause.

```bash
git add -A && git commit -m "Fix: Gemini-only, model fallback chains, aggregate provider errors, acknowledge non-text messages"
```

> You have **zero commits since Phase 0** — all of Phase 1 and Phase 2 is uncommitted. Commit before anything else.

---

## Audit of what you've built

I read every file. The architecture is holding up.

**Correct, and worth keeping:**

- The `convex/lib/` purity rule survived contact with real code. `errors.ts`, `resolve.ts`, `plan.ts`, `time.ts` are all pure and all unit-tested.
- `raiseForStatus` centralising the retriable/fatal split across vendors is better than what I originally specified.
- `errors.ts` treating a quota-exhausted 400 as retriable is right, and the narrow body-signal matching is right — a blanket "400 is retriable" would swallow real bugs.
- The Gemini thinking-token reserve is a genuinely good find. Gemini 3.x billing reasoning against `maxOutputTokens` is a real trap and you handled it.
- `parseTextMessage` narrowing the untrusted webhook body field by field is exactly the invariant-I-2 posture.

**Wrong, now fixed:** last-error-only reporting, single model per tier, silent drop of non-text messages, `TRANSCRIBE` pointed at a chat model chosen without checking audio support.

**Still outstanding:**

1. **Nothing is committed.** One `git rm --cached` mistake and Phase 1 and 2 are gone.
2. **`REQUIRED_NOW` may be stale.** Check `convex/lib/config.ts` still lists what Phase 2 actually consumes, or `/health` is reporting green on a broken deployment.
3. **No adversarial tests yet.** Appendix C #14 — "provider returns 429, fails over, logs it" — is the one that would have caught this whole class of problem. Worth writing now while it's fresh.
