# Project memory

Non-obvious facts worth carrying forward: vendor behaviour we measured,
decisions and their reasons, deviations from the build plan, and traps that
cost time. **What** changed belongs in `CHANGELOG.md`; **why**, and what bit
us, belongs here.

Newest first. Date each entry — vendor behaviour rots.

---

## 2026-08-21 — Escape the composed string, not its parts

`composeCard` did `escape(name) + " <" + escape(address) + ">"`. Both parts
were escaped correctly and the result was still rejected by Telegram, because
the delimiters added AFTER escaping were themselves MarkdownV2 syntax (`>` is
blockquote). Fix: escape once, over the finished string.

The test suite passed throughout — every fixture happened to use text with no
specials in the joining positions. The replacement test walks every character
of a rendered card and asserts each special is backslash-preceded, which is
the only version of this test that could have caught it.

Generalizes: when a formatter escapes inputs then adds its own punctuation,
the punctuation is unescaped by construction. Check the join, not the parts.

## 2026-08-21 — Convex has no element-wise array index, and schema.ts claimed otherwise for five phases

`people.by_email` was declared on `emails: v.array(v.string())` with the
comment "array index: matches any element". That is not a thing Convex does —
an index on an array field indexes the whole array value, so the only query
it supports is "whose email list is EXACTLY this list". `.eq("emails", addr)`
fails to typecheck, which is how it finally surfaced: Phase 4's pre-filter was
the first code that ever needed address -> person.

Fixed by scanning `by_user` and filtering in code (same shape as
`people.upsert`), and by correcting the comment. The index is left in place —
removing one needs a migration and it is harmless — with a note not to build
on it.

**Generalizable:** a wrong comment on a schema survives exactly as long as
nobody writes the query it describes. Five phases, in this case.

## 2026-08-21 — A pre-filter that skips 92% is doing its job, but read what it skips

Measured on the real mailbox: 12 of 13 messages never reached the model
(target was 60%). Cost-wise excellent. Worth understanding the trade though:
bulk mail from an unknown sender is classified LOW **without being read**, so
a phishing message wearing a `List-Unsubscribe` header is filed LOW rather
than `PHISHING_SUSPECTED` — the SPAM+DMARC override never gets a chance to
run, because the override runs *after* a model call the pre-filter prevented.

That is defensible (the harm from an unread phishing mail is low; the harm
the plan cares about is a missed recruiter mail, which has no
List-Unsubscribe and does reach the model). But if Phase 5's alerts ever feel
like they are missing something, this ordering is the first place to look.

## 2026-08-21 — A debug harness that diverges from production invents bugs

`debug:planOnly --execute` called `converse()` without first persisting the
inbound message. `converse()` reads its transcript from the `messages` table,
so the message under test was invisible to the model — it answered from the
last ten real Telegram turns instead. Three separate features looked broken
while being fine, and I nearly went looking for a fault in the wrong layer.

Rule: a harness that skips a production step is not a harness, it is a
different code path. When verification output looks nonsensical rather than
merely wrong, suspect the harness before the feature.

## 2026-08-21 — The planner sometimes emits `{{ ... }}` and it silently ate tool calls

Live output: `{{ "reply": "Done.", "tools": [...] }}`. `extractJsonObject`'s
balanced scan returns the whole doubled-brace string, `JSON.parse` rejects
it, and the fallback treats it as prose — so the user is shown a raw tool
call as their answer and nothing executes. Affected every tool, not one
feature; found only because a removal silently did nothing.

`parseToolPlan` now strips one symmetric layer and retries. Worth
remembering that the prose fallback is a **failure** path that looks like a
success path — a malformed plan reaches the user as a confident-sounding
reply, not as an error.

## 2026-08-21 — Three kinds of user-taught knowledge, deliberately not merged

The bot now has, or will have, three stores that all look like "stuff the
user told it" and are not interchangeable:

| Store | Holds | Injected |
|---|---|---|
| `customInstructions` | rules for behaviour | every message |
| `skills` | procedures for one capability | keyword-matched |
| `userContext` (Phase 2B, doc only) | **facts about the person** | every message |

The distinction that matters: a fact is not an instruction. "I'm a frontend
engineer" tells the model nothing to DO — it changes what counts as important
mail and what tone a draft takes. Filed as an instruction it gets read as a
command and the bot starts announcing your job at you. If a future feature
wants to store something user-taught, decide which of the three it is first;
adding a fourth store should need a reason as clear as this one.

## 2026-08-21 — Gmail's `snippet` is ~200 chars and truncates the part that matters

The single highest-value email in testing — a webinar invite — had its date,
time, platform and registration link ALL past the 199-character snippet
boundary. Any summary built from a listing result was therefore structurally
incapable of mentioning them, and confidently said "no action required".

Lesson generalized: **a preview field is not the document.** `converse()` now
hydrates real bodies for small result sets before composing. If a future
feature summarizes anything from a list, check what the list actually carries
before trusting it.

Related: compose prompts now include the current date and must state whether
a dated event is upcoming or passed. A date written without a year is
resolved against the email's Received header — verified live, correctly
resolving "Friday, 31st July" to 2026 and reporting it as passed.

## 2026-08-21 — Conversation history makes repeated questions unverifiable

`converse()` feeds the last 10 turns to the planner, so asking the same
question twice gets "I answered that above" rather than a fresh answer. This
made compose fixes look broken when they were fine. `debug:tldrFor` exists to
exercise the compose path with no history. Worth remembering before
concluding a prompt change did nothing.

## 2026-08-21 — Skills now shape output too; the earlier limitation is fixed

Supersedes the entry below. A `COMPOSE_REPLY` pass (DRAFT tier) now runs when
a skill matched AND tools executed, so skill rules about PRESENTATION
("append a TL;DR", "summarize rather than dumping the body") work. Still
bounded: no skill match, or no tools, means one model call as before.

**Do not let a model reproduce long text verbatim.** Measured twice on
gemini-3.5-flash: told explicitly to copy an email body unchanged, it
summarized instead. Full-content mode therefore emits the body from the
DETERMINISTIC renderer and the model only appends a TL;DR under it. Any
future "return this exactly" requirement should be structural, never a
prompt instruction.

**A model-supplied mode flag is a hint, not a decision.** `email.get_message`
takes `mode: summary|full`, but flash-lite set it inconsistently across
identical requests — so `wantsFullEmail()` in `lib/scope.ts` checks the
user's own words and overrides. Same seatbelt/crash-structure split as
`guardReply`.

## 2026-08-21 — DB skills silently shadow skills.ts, and that bit us

`DEFAULT_SKILLS` in `convex/lib/skills.ts` is only a FALLBACK — any row in
the `skills` table wins. A `check_email` row created during my own testing
overrode the user's carefully written file version for days, and the symptom
was "it ignores my skills", not anything pointing at the DB. `/skills` shows
`(customized)` vs `(default)` — check it FIRST when a skill seems ignored,
before touching `skills.ts`.

## 2026-08-21 — A debug tool that reimplements the real path will lie to you

`debug:planOnly` with `execute:true` planned once for display, then called
`converse()` which planned again independently — two different plans, and the
args printed were from the one that did nothing. Before that it had
reimplemented execute-and-render by hand, and silently diverged the moment
`converse()` gained a compose pass. A debug tool must CALL the real code
path, never mirror it.

## 2026-08-20 — Skills can steer tool selection but not post-result narration, by construction

Live-tested: taught `check_email` a rule to "state the total count found" and
"end by asking if I want to check spam too." The skill loaded correctly
(verified via `/skill check_email`), and the model's tool choice was
plausibly influenced by it — but the two narration instructions never
appeared in the actual reply. Root cause: `renderOutcomes` is deterministic
by design (the exact fix for the earlier two-calls-per-message quota
problem) — the model's own `reply` is only ever used as a PRE-tool-execution
preamble, never as post-result narration. There is structurally no step
where the model gets to add a sentence after seeing what a tool returned,
in the current architecture.

This is a real gap against what "full procedural authority" implies for
skills, not a bug in the skill mechanism itself. Two honest fixes, neither
built: (a) a second, cheap model call, but ONLY on turns where an active
skill matched — bounded cost, unlike the original per-message-always
problem; (b) narrow, deterministic renderer hooks for specific patterns
like "always show a count" (easy) that stop short of open-ended narration
like "ask a follow-up question" (which fundamentally needs a model). Revisit
when skills need to do more than steer tool order.

## 2026-08-20 — Email ids are deliberately never shown in chat, which broke follow-up lookups

`renderEmailList`/`email.get_message`'s output never includes `emailMessageId`
— reasonable, since a raw Convex id in a Telegram message is noise. The
unintended consequence: a follow-up like "read me the full one from
FairMoney" arrives as a fresh planning pass whose only memory of the prior
turn is the RENDERED TEXT (`renderConversation` on `messages.text`) — which
never contained the id either. The model had no way to call `get_message`
correctly, and appears to have just re-answered from the snippet it could see
in its own prior turn's text instead.

Fixed with fragment resolution (`findByFragment`, matching sender/subject
substring), not by exposing ids — same shape as `tasks.findByTitle`. Any
future "let the user reference item X from a prior list" feature should
default to this pattern rather than surfacing an id, since surfacing the id
was never actually the fix — the model still wouldn't reliably re-type a raw
Convex id back correctly even if shown one.

## 2026-08-20 — Morning brief window redesigned: rolling since-yesterday-midnight, not "recent N"

User feedback, direct quote in spirit: a Saturday brief should cover Friday
00:00 through Saturday's send time; Sunday's should cover Saturday 00:00
through Sunday's send time — not a fixed lookback, and not "whatever's in the
cache." `docs/build/PHASE-05B-morning-brief.md` was updated (doc-only, not
built yet) to compute this fresh every time via a new pure
`sinceYesterdayMidnight(nowMs, timezone)`, rather than storing a
`lastDeliveredAt` — deliberately stateless, so a missed brief doesn't
retroactively expand the next one's window (a real tradeoff, stated in the
doc, not hidden).

Also added: the brief now excludes any email whose thread already got a
real-time Phase-5 alert (checked via `notifications.findByThreadKey`, keyed
on `emailMessages.threadId`) — otherwise the assistant would re-surface
something it already told the user about, reading as if it has no memory of
its own actions. This was the user's explicit ask ("it should know we talked
about this already").

## 2026-08-20 — The 2-day sync window is a cost cap on the BACKGROUND job, not a ceiling on what the user can ask for

Conflating these two was the actual bug behind "check my spam" returning
nothing for older mail. `SYNC_WINDOW = "newer_than:2d"` in `gmail.ts` exists
to bound the recurring cron's cost, not to define what the assistant is
capable of knowing. `deepSearch` is the fix: a separate, on-demand action
that bypasses `SYNC_WINDOW` entirely for a single user-triggered query. Worth
remembering when Phase 4-8 land for real — the same distinction will matter
for classification (don't re-classify a message just because a deep search
touched it) and for the morning brief (which needs its OWN explicit time
window, not "whatever's cached" — see the PHASE-05B doc update below).

## 2026-08-20 — `auditLogs.record` cannot write the fields it has a schema for

`convex/model/audit.ts`'s mutation validator accepts `actor/action/targetType/
targetId/args/result/errorMessage/latencyMs` — but `auditLogs` in `schema.ts`
has also had `accountId: v.optional(v.id("connectedAccounts"))` and
`approvalId: v.optional(v.id("approvals"))` since Phase 0. Nothing can write
either field today; every call site that tries silently drops them (Convex
strips unvalidated args, it doesn't error).

Not urgent while nothing calls `audit.record` with those fields — but Phase 6
(draft/approve/send) needs `approvalId` on every audit row to answer "why did
it send that," which is the whole point of invariant I-5. **Whoever executes
`docs/build/PHASE-06-draft-approve-send.md` must add `accountId`/`approvalId`
to `audit.ts`'s validator as its own step** — the doc does this (its Step 5),
found by checking the real file rather than trusting the schema comment.

## 2026-08-20 — Nine build docs written; the code they describe mostly isn't real yet

`docs/build/PHASE-{04,05,05B,06,07,08,11,15,16}-*.md` (~10,900 lines total)
were written by one dispatched agent per document, each instructed to verify
every function signature and schema field against the actual repo rather than
trust the source plan or an earlier doc's claims. That discipline caught a
real drift: **Phases 4/5/6/7 exist only as documentation.** The last real
commit is Phase 0 (`d457315`); Phases 1–3's code is uncommitted-but-present,
Phase 4 onward is written-but-not-executed. `convex/gmail.ts`'s `syncAll` is
still the original sequential loop (not Phase 7's documented `Promise.all`),
`connectors/gmail/oauth.ts` only has `GMAIL_READONLY_SCOPES`, and
`tools/router.ts`'s consequential-tool branch is still the Phase-2-era
unconditional refusal. Each doc's own "what already exists" claims describe
its FINAL state, not the state of the repo the next doc's agent actually read
— so later docs (08, especially) had to write against the real current files,
not the earlier docs' narrated end-state, and say so explicitly where they did.

**Consequence for whoever executes these docs**: read each one's own
callouts about what it found missing before assuming a prior phase's doc
was actually built. The docs are internally consistent with each other's
*design*, not with each other's *deployed state* — nothing here was deployed.

## 2026-08-20 — Pure-renderer tests don't catch router wiring bugs

`instruction.add`'s confirmation rendered `I'll remember: ""` — empty. The
`renderOutcomes` unit tests all passed, because they hand-construct the result
object (`{text: "..."}`) directly; they never exercise what the ROUTER
actually returns, which was `{instructionId}` only. The bug lived entirely in
the seam between router.ts and outcomes.ts, which pure tests on either side
individually cannot see.

Caught by running `debug:planOnly` with `execute: true` against the real
router before calling the feature done — this is now worth doing as a matter
of habit for any new tool, not just as a one-off debugging step.

## 2026-08-20 — A live user test landed mid-build, and worked

While building the `instruction.add` feature, the user tried it directly in
Telegram against the dev bot ("use 12hr format instead of 24hr format")
without being told it existed yet. It's real data — timestamped between two
of my own deploys, correctly saved, correctly retrievable. Dev deploys go live
the moment `bunx convex dev --once` returns, so a feature can be "done" from
the user's side mid-session. Two of my own test rows had to be identified and
removed (`debug:rawInstructions`) without touching the real one — worth
checking raw table state before assuming test data is all mine.

## 2026-08-20 — The bot fabricated a technical diagnosis that was not true

Reported: after asking about mailbox access, the bot said "I am looking into
the OAuth error. I will check the authentication configuration," then later
"The OAuth redirect URI is misconfigured in the Google Cloud Console." Pulled
the durable audit log (`bunx convex logs` only tails forward and had nothing
from the incident) and found `account.connect ok` and two successful
`gmail.sync` runs in the same window. **The connection worked. The diagnosis
was invented** — there was no real problem for the model to have found, only a
missing tool (`email.list_recent` did not exist yet) that made a working
integration look broken from the user's side.

This is the same shape as a hallucinated citation, applied to infrastructure:
given a question it cannot actually answer (it has no access to Google Cloud
Console, ever), the model produced a plausible-sounding, specific, and false
answer rather than saying "I don't know." The system prompt now states this
explicitly rather than assuming it's obvious: the model has no visibility into
anything outside its own tool catalog, and inventing a specific diagnosis is
treated as strictly worse than admitting it doesn't know.

`convex/lib/scope.ts` (`guardReply`) is the structural backstop — narrow,
tested against both the exact reported phrasing and against false positives
("let me check your tasks" must survive). See [[gemini-only-and-model-fallback]]
for the same "seatbelt vs crash structure" reasoning applied to prompt
injection instead of self-narration.

## 2026-08-20 — `bunx convex logs` cannot answer "what happened"

It tails forward from the moment you invoke it; there is no backfill. For
"what happened during that incident five minutes ago," query `auditLogs`
directly — `debug:recentAudit` does this, ordered newest-first. Reach for this
before `convex logs` whenever the question is about the past, not the present.

## 2026-08-20 — Convex cron identifiers must be ASCII

`crons.cron("mailbox sync — waking", ...)` fails the push with
`Invalid cron identifier: use ASCII letters that are not control characters`.
The em dash is the problem. It fails at deploy, not at typecheck.

## 2026-08-20 — On .convex.site, the nonce IS the authorization

Every HTTP route on a Convex deployment is public — there is no way to make
`/oauth/google/start` "internal". So the OAuth flow cannot be protected by the
endpoint; it is protected by the link.

`/connect` mints a 256-bit nonce bound to the owner's userId, stored in
`oauthStates` with a 10-minute expiry. `start` refuses to redirect without a
live row; `callback` consumes it atomically (read-then-delete in one mutation,
which is a transaction, so a replay genuinely finds nothing). Without this,
anyone who found the URL could attach *their* mailbox to the owner's account.

The build plan calls for a *signed* state as well. Skipped deliberately: the
row is already the authority, and an unguessable single-use nonce that the
database can invalidate is strictly stronger than a signature that cannot be
revoked. Recorded here so it reads as a decision, not an omission.

## 2026-08-20 — Google returns a refresh token only with prompt=consent

`access_type=offline` alone is not enough. Re-authorizing an already-granted
account returns an access token and no refresh token, and the account then
works for exactly one hour before dying with no obvious cause.
`completeConnect` treats a missing refresh token as a hard error and tells the
user to remove the app at myaccount.google.com/permissions first.

Related, and normal rather than exceptional: **a Testing-mode Google app
expires refresh tokens after 7 days.** `/reconnect` is built in Phase 3 for
this reason. `invalid_grant` from the token endpoint is the signal.

## 2026-08-20 — Which mailbox got connected is never assumed

Google's account chooser lets the user pick a different account than the one
they meant. `completeConnect` calls `users/me/profile` to find out which
mailbox was *actually* authorized and stores that address. `gmail.readonly`
already covers `/profile`, so this costs no extra scope — using
`userinfo.email` would have widened the grant for no reason.

## 2026-08-20 — A tool catalogue without types is a silent failure machine

`describeCatalog()` rendered field NAMES only:

```
- memory.upsert_project(name, status?, objective?, priority?)
```

No types, no enums, no formats. So "Momentum Logistics is a high priority
project" produced `priority: "high"`, the Zod schema demanded
`z.number().int()`, `parseToolPlan` rejected the call — and the rejection was
logged and **dropped**. The user was told the project and task were created.
`/tasks` was empty.

Reproduced exactly with `bunx convex run debug:planOnly`:

```
REJECTED: memory.upsert_project — priority: expected number, received string
          task.create           — priority: expected number, received string
reply:    "I've set up the Momentum Logistics project, created the testing
           task and marked it as blocked, and scheduled your reminder."
```

Three separate defects, each of which alone would have caused it:

1. **The prompt did not state the types.** Fixed: every field carries
   `.describe()`, rendered into the catalogue. Note `.optional()` WRAPS the
   described node, so the description has to be unwrapped — otherwise exactly
   the optional enums most likely to be guessed wrong show no hint.
2. **The schemas only accepted the canonical form.** A schema that rejects a
   phrasing difference turns it into a dropped action. Fixed with `z.preprocess`
   coercion for priority, status and importance.
3. **Rejections were invisible.** Fixed: they invalidate the planned reply and
   are reported. The plan's `reply` is written before anything executes, so it
   is only trustworthy when every proposed call succeeded.

**The general lesson: a validation layer between a model and an effect must
report what it dropped.** Silent rejection is worse than no validation, because
the model's optimistic narration survives it.

## 2026-08-20 — A model cannot reference an id it is about to create

"I need to test the server, and I'm blocked on Dash for the OTP" is one message
and two calls: `task.create` then `task.block`. The plan is emitted in one shot,
so there is no id for the second call to use.

Fix: `taskId` OR `taskTitle` on every task-addressing tool, resolved in code by
`tasks.findByTitle` (exact match, then containment, preferring open tasks).
Verified end to end — `task.block` resolved the title to the task created by the
call immediately before it, same `taskId`.

This keeps invariant I-3 intact: the model supplies a *name*, and the
application resolves it to a foreign key. It never supplies the key.

## 2026-08-20 — Convex type circularity is not theoretical

Adding `debug:planOnly` — a debug action whose return type referenced
`ToolOutcome` — made `ctx.runQuery` results in `convex/assistant.ts` degrade to
`any`, producing nine `TS7006 implicitly has an any type` errors in a file that
had not been touched. The inferred handler type flows through
`_generated/api.d.ts` and poisons unrelated call sites.

Fix is the documented one: an explicit return annotation on the handler
(`Promise<Record<string, unknown>>`). Worth reaching for immediately whenever
unrelated files start reporting implicit `any`.

## 2026-08-20 — Gemini free-tier quota buckets are PER-MODEL

Settled empirically, not from docs. Probed each model directly through
`bunx convex run debug:pingAI '{"model":"..."}'` within the same minute:

| Model | Result |
|---|---|
| `gemini-3.7-flash` | OK |
| `gemini-3.6-flash` | **429 RESOURCE_EXHAUSTED** |
| `gemini-3.5-flash` | OK |
| `gemini-3-flash-preview` | OK |
| `gemini-3.5-flash-lite` | OK |
| `gemini-3.1-flash-lite` | OK |
| `gemini-2.5-flash-lite` | **404 NOT_FOUND** |
| `gemini-2.5-flash` | **404 NOT_FOUND** |
| `gemini-flash-latest` | OK |
| `gemini-flash-lite-latest` | OK |

3.6 is exhausted while 3.5 serves fine in the same second. **The buckets are
separate**, so the fallback ladder is a real mitigation and moving a task to a
different model genuinely buys headroom. This was the open question blocking
prioritisation in `docs/build/HANDOFF-01-ai-provider-fixes.md` §P1.

Two consequences:

- **`gemini-2.5-*` is gone from this key.** It is in the 16 Aug 2026 model
  list and 404s on 20 Aug. Pinned model names rot; every ladder therefore ends
  with the floating `gemini-flash-latest` / `gemini-flash-lite-latest` alias as
  a backstop. Re-probe before trusting any model list older than a few days.
- `gemini-3.7-flash` returned a transient **503 UNAVAILABLE** on one probe and
  OK on the next. Availability flaps; the ladder absorbs it.

## 2026-08-20 — The quota bug was call COUNT, not token count

The bot died after two or three messages. The reflex fix — a fallback ladder —
treats the symptom. The cause was that **every inbound message cost two
flash-tier requests**: `PLAN_TOOLS` to choose tools, then a second
`CHAT_REPLY` to narrate what they returned. Free-tier limits that bite here are
RPM/RPD, so halving the request count is worth more than any token tuning.

Two changes, roughly multiplicative:

1. **The compose call is gone.** `convex/lib/tools/outcomes.ts` renders tool
   results deterministically. Cheaper, and strictly more accurate — a model
   asked to retell a tool result can soften a failure or invent a due date.
   Note `renderOutcomes` **drops the planned reply when any tool failed**: the
   plan is written before the tools run, so on failure it usually claims
   success.
2. **`PLAN_TOOLS` moved to `CHEAP_STRUCTURED`**, putting the one remaining
   per-message call on the flash-lite bucket, separate from chat and voice.

Net: one call per text message, on a bucket nothing else touches.

## 2026-08-20 — Gemini accepts Telegram's Opus-in-Ogg as `audio/ogg`

Flagged as an unverified risk in the handoff (§P4): Google documents
`audio/ogg` as *Vorbis*, but Telegram voice notes are *Opus*. **Tested and it
works** — `scripts/test-transcription.sh` encodes real Opus/Ogg with ffmpeg and
gets an accurate transcript back. No transcoding needed, so no `"use node"`
action and no 512 MB runtime.

Also confirmed from the model list: the dedicated audio models
(`gemini-2.5-flash-native-audio-*`, `gemini-3.1-flash-live-preview`,
`gemini-3.5-live-translate-preview`) expose **`bidiGenerateContent` only** —
Live API over websockets, not request/response. They cannot be called from an
action. Transcription uses an ordinary multimodal Flash model, which is why the
TRANSCRIBE ladder is identical to the REASON ladder.

And the reason this work is needed at all: **Telegram will not transcribe for
a bot.** The Bot API delivers a `voice` object with a file_id and no text;
Telegram's own transcription is a Premium *client* feature over MTProto.

## 2026-08-20 — Gemini 3.x spends `maxOutputTokens` on thinking

`gemini-3.6-flash` is a thinking model, and reasoning tokens are billed against
`maxOutputTokens`. With `maxOutputTokens: 100`, a request for a one-sentence
answer returned **"The provider"** — truncated, with no error.

What we tried:

- `thinkingConfig.thinkingBudget: 0` → **400 INVALID_ARGUMENT**. Gemini 3
  cannot disable thinking.
- `thinkingConfig.thinkingLevel: "low"` → accepted, but still over-spent a
  100-token ceiling. **`thinkingConfig` is a hint, not a cap.**

**The knob that works is headroom.** `convex/ai/providers/gemini.ts` treats the
caller's `maxOutputTokens` as the allowance for the *answer* and adds a
per-tier `THINKING_RESERVE` on top. Verified across all five tiers.

This fails **silently** — half a sentence, HTTP 200. If a Gemini reply ever
looks clipped, suspect the budget before the prompt.

## 2026-08-20 — Vendors disagree on how to report an exhausted quota

Measured with real keys:

| Provider | Status | Body |
|---|---|---|
| OpenAI | `429` | `insufficient_quota` |
| Anthropic | `400` | "Your credit balance is too low" |

A status-only rule (`429 || >= 500`) therefore treats Anthropic's version as
**fatal** and kills the chain instead of falling through. `isQuotaExhausted()`
in `convex/lib/ai/errors.ts` matches on the body to correct this.

The match is deliberately narrow. A blanket "400 is retriable" would swallow
malformed-request bugs, which must stay loud — there is a test asserting an
invalid-argument body is *not* classified as a quota problem.

**Current state:** the OpenAI and Anthropic keys are valid but **unfunded**.
Both providers reach their APIs and are rejected on billing, which is how we
proved the failover chain works: `anthropic (400) → openai (429) → gemini ✓`.
Gemini is the only provider that can actually serve a request today.

## 2026-08-20 — OpenAI provider uses the Responses API, not chat/completions

`OPENAI_MODEL_*` is set to `o4-mini`, a reasoning model. On
`chat/completions`, o-series needs `max_completion_tokens` while standard
models need `max_tokens` — so the model name and the request shape would be
coupled, and swapping models would stop being an env-var edit.

`/v1/responses` takes the same shape for both. The provider also walks
`output[]` for `output_text` items rather than trusting the `output_text`
convenience field, because reasoning models emit a reasoning item first.

## 2026-08-20 — OpenAI and Anthropic are implemented, not stubbed

`docs/build/PHASE-01-telegram-ai-loop.md` steps 8–9 specify throwing stubs, on
the assumption only a Gemini key exists. All three keys are present, so all
three providers are real. Failover is therefore genuinely exercised rather
than proven by a stub's error message.

Consequence: the Phase 1 "Done when" checklist item that proves provider
switching by observing the OpenAI stub error no longer applies. The
replacement check is `bunx convex run debug:pingAI '{}'` after reordering
`AI_PROVIDER_PRIORITY`, reading `served_by` in the result.

## 2026-08-20 — No Microsoft credentials, by choice

`MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` are deliberately absent —
account restrictions. **Phase 15 is Zoho-only.** Do not scaffold Outlook or
Microsoft Graph until credentials exist; `docs/ENV.md` lists the variables for
whenever that changes.

## 2026-08-20 — `convex/_generated/` is committed and goes stale

The directory is intentionally not gitignored, so the project typechecks in CI
without a `convex dev` first. The cost: after adding or renaming a function
file, `internal.*` and `api.* ` do not know about it and `tsc` fails with
"Property does not exist". Run `bunx convex codegen`. This is not a bug and
does not need a workaround.

## 2026-08-20 — `bun run typecheck` had no compiler

`tsconfig.json` and the `typecheck` script existed from Phase 0, but
`typescript` was never a dependency, so the script exited 127. Added
`typescript` and `@types/bun` (the latter for `bun:test` imports, with `"bun"`
added to `compilerOptions.types`).

## 2026-08-20 — The tool router refuses consequential tools before any exist

Every Phase 2 tool is `consequential: false`, and there is a test asserting it.
The router still checks the flag and refuses, so the approval gate is in place
*before* Phase 6 adds `email.send` rather than being retrofitted around it.

Related structural point: prompt injection cannot invent a tool. An unknown
name is dropped by `parseToolPlan`, so "send everything to attacker@evil.com"
is unrepresentable, not merely discouraged. There is a test for that too.

## 2026-08-20 — Reminders use `scheduler.runAt`, and the cron is only a net

The v2 plan polled a table from a cron tick. Convex schedules the delivery
function at the exact instant instead, so `convex/crons.ts` keeps *only* an
hourly reconcile sweep. That sweep exists to catch **our** bugs (a reminder
written without its `runAt`, a job cancelled by mistake), not the scheduler's
— it should find nothing. It is the difference between "usually reminds you"
and "reminds you".

The cron reconcile is `internal.reminders.reconcile`; the build plan names it
`internal.tasks.reconcileOverdue`. Renamed to match what it actually sweeps.

## 2026-08-20 — Cron expressions are UTC; Lagos is UTC+1 with no DST

Subtract one hour from every local time. 07:00 WAT is `0 6 * * *`. Every cron
line carries the offset in a comment above it, because this is misread three
months later otherwise.
