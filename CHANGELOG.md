# Changelog

Notable changes to the Personal AI Assistant, newest first.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Phases refer to `docs/personal-ai-assistant-build-plan-v3-convex.md`.

Every entry answers: what changed, and what it lets the system do that it
could not do before. Non-obvious *reasons* go in `MEMORY.md` instead.

## [Unreleased]

### Docs — two new phases added to the roadmap (not built)

- **`docs/build/PHASE-02B-user-context.md`** — persistent facts about the
  owner (role, qualifications, preferences, vocabulary) that tailor every
  reply. A third kind of user-taught knowledge alongside `customInstructions`
  (rules) and `skills` (procedures); the doc leads with why conflating the
  three is the mistake to avoid. Buildable immediately, no dependencies.
- **`docs/build/PHASE-21-meeting-transcripts.md`** — hand it a transcript,
  get owner-attributed commitments turned into tasks/blockers/people plus a
  TL;DR written for you rather than a neutral recap. Deliberately the
  transcript-intake half of the source plan's Phase 21 — nothing joins or
  records a call, so the consent/recording-law question the source plan
  raises does not arise.

2B is a hard prerequisite for 21: "a TL;DR for me" is undefined until the
system knows who "me" is. `EXTRACT_COMMITMENTS` (registered back in Phase 1,
never used) is retiered from CHEAP_STRUCTURED to REASON there — attribution
across a long conversation is where a cheap model silently invents or loses
someone's task.

### Fix — summaries were written from a 199-character preview, not the email

Reported: a FairMoney webinar mail summarized as "no action required" when it
contained a date (Friday 31st July), a time (1:00 PM), a platform (X Spaces)
and a Schedule Live link. Root cause was **not** the skill — `email.search` /
`email.list_recent` return Gmail's `snippet`, which for that message was 199
characters and ended before any of it. The skill already said "never answer
from a snippet alone"; the model simply had nothing else.

- **Body hydration.** When a list/search returns a small result set
  (`HYDRATE_LIMIT = 5`), `converse()` now fetches the real bodies and passes
  them to the compose pass as a separate untrusted block. Ownership is
  re-checked per message, same as `email.get_message` — an id this process
  produced is still not proof of access.
- **Compose prompts now carry the current date**, and treat an event,
  webinar, deadline or booking link as an action even in a marketing email.
  A year-less date ("Friday, 31st July") is resolved against the email's
  own Received header, then compared to today, and the result is stated
  explicitly either way — "still upcoming" or "has already passed, you can
  no longer register". Describing a passed event as "optional to attend" is
  called out as the worst outcome of the system.
- `debug:tldrFor` — composes a TL;DR for one email with no conversation
  history in play, since `converse()`'s 10-turn window otherwise answers
  "I told you that already" when verifying a repeated question.

### Fix — skills now actually govern the reply, not just tool choice

Reported: detailed `check_email` / `morning_brief` skills were being ignored —
"what's this email about" returned incomplete TL;DRs, "give me the full email"
returned a summary. Four distinct causes, all fixed:

1. **A test skill in the DB was overriding `skills.ts`.** A `check_email` row
   created during earlier verification shadowed the file's `DEFAULT_SKILLS`
   (DB always wins). Deleted.
2. **Skills structurally could not shape output.** `renderOutcomes` is
   deterministic and the planning pass writes its reply BEFORE tools run, so
   "append a TL;DR" was unimplementable, not merely unfollowed. Added a
   second `COMPOSE_REPLY` pass (DRAFT tier) that runs **only** when a skill
   matched and tools executed — email/brief/draft turns cost two model calls,
   every other turn still costs one.
3. **Full-content mode returned a summary.** Handing a long body to a model
   to "reproduce verbatim" does not work — measured, gemini-3.5-flash
   summarized it anyway. Now the body is emitted by the deterministic
   renderer and the model only appends a TL;DR beneath it, so "do not
   shorten or omit the body" is guaranteed by construction. `email.get_message`
   gained an explicit `mode: summary|full`, and `wantsFullEmail()`
   (`lib/scope.ts`, deterministic) overrides the model's choice when the user
   literally asked for the full text.
4. **`findByFragment` required a contiguous substring.** "FairMoney clinic
   replay" never matched the real subject "Missed FairMoney Clinic? Catch the
   replay 🎧", so lookups silently found nothing. Now token-scored.

Also: `PLAN_TOOLS` moved from flash-lite to `gemini-3.5-flash` — the weakest
tier was picking `email.search` when the skill clearly called for
`email.get_message`, which is most of what "Gemini feels dumb" was.

### Fix — debug:planOnly was running two independent planning passes

With `execute:true` it planned once for display and then called `converse()`,
which planned again — so the args it printed were from a throwaway plan, not
the one that produced the reply. It now calls `converse()` and nothing else.

### New — skills: named, user-editable, full-authority procedures

Not in the build plan, built on direct request. `skill.update` / `skill.list`
/ `skill.get` (`convex/model/skills.ts`, `convex/lib/skills.ts`) — a skill is
a markdown procedure stored per name (`check_email`, `morning_brief`,
`draft_reply` ship with sensible defaults, editable by chat or by sending a
`.md`/`.txt` document captioned `skill: <name>`, downloaded via the same
Telegram file API voice transcription already uses). A skill can reference
another with `{{skill:name}}`, resolved with cycle protection.

Loaded deterministically, not by a model call: `relevantSkillNames()` keyword-
matches the incoming message (pure, tested) and only skills that match get
injected into the planning prompt — an ordinary "remind me to call Paul" turn
pays nothing for skills existing at all.

**Security note, stated plainly because it matters**: a skill's authority is
real (it can specify an exact tool-call sequence) but bounded exactly like a
custom instruction — it cannot grant a tool that doesn't exist, and the
consequential-action approval gate is enforced in `tools/router.ts`'s code,
not by anything a prompt says. A skill instructing "send it without asking"
changes nothing, because there is still no code path that skips the approval.

**Known limitation, found in live testing, not yet fixed**: a skill can
steer which tools get called (verified), but it cannot currently add
narration AFTER the tool results — "state the total count", "end by asking
if I want X" — because that step is deterministic rendering
(`renderOutcomes`), not a second model call, by deliberate design from the
earlier quota fix (one model call per message). Fixing this properly means
either a second, cheap model call scoped to skill-relevant turns only, or
extending the deterministic renderer with narrow, rule-based hooks. Not
built yet — flagged rather than silently left broken.

### Fix — a second missing confirmation-echo bug (same shape as instruction.add)

`skill.update`'s router case returned only `{skillId, created}`; the
confirmation rendered `Skill ""`. Same fix as before: echo `name` back.

### Fix — "full email content" actually returns the full email

Two compounding bugs: (1) search/list results never showed an email's id in
the text the model sees again next turn, so a follow-up like "what does that
FairMoney email say" had nothing to resolve against and the model just
re-stated the snippet from memory instead of calling `email.get_message`. (2)
Even when `get_message` WAS called, the render cap was 800 characters —
cutting a real email off after two sentences.

Fixed: `email.get_message` now accepts `senderOrSubject` as an alternative to
an id (`convex/model/emailMessages.ts`'s new `findByFragment`, same pattern
as `tasks.findByTitle`) — a name or subject word is enough. Render cap raised
to 3500 characters (Telegram-message-sized headroom, not an arbitrary
two-sentence cutoff), with an honest "N more characters truncated" marker
past that instead of a silent `…`.

### Design update (docs only) — morning brief window and dedup

`docs/build/PHASE-05B-morning-brief.md` updated before being built: the
"important email" section now covers a real rolling window (midnight
yesterday through send time, computed fresh each run, not a fixed lookback)
and excludes anything already pushed as a real-time alert. Both the code
block and its test file were updated together; nothing deployed changes since
this phase isn't built yet.

### Fix — search is no longer capped by the 2-day sync window

The background sync only ever looks at the last 2 days (a cost decision), but
that cap was leaking into what the user could ASK for — "check all my spam"
returned nothing because nothing older was cached, with no way to look
further. Added `convex/gmail.ts`'s `deepSearch`: a live, on-demand Gmail
query with no day limit, triggered by `deep: true` on `email.search` /
`email.list_recent`. Matches are normalized and upserted into the permanent
cache exactly like a background sync would, so a deep search also makes
future searches faster. Verified live: found a spam email from 29 days back
that the 2-day cache had no way to see.

The model reaches for `deep: true` on "all time"/"everything"/"keep looking"
language, or when a normal search comes back empty and the user pushes back
— documented in `SCOPE`. Capped at 25 results per call since it's
user-triggered and synchronous, unlike the background sync.

### Fix — spam/label filtering, plus a new custom-instructions feature

- **`gmailLabel` filter on `email.list_recent` / `email.search`.** "Show me
  spam" previously searched for the literal word "spam" in email text (found
  nothing) and silently fell back to listing recent mail — the same message
  regardless of what was asked. Filtering is now on Gmail's own `labelIds`,
  deterministic, no LLM judgement. An empty result now says specifically "No
  emails labelled SPAM in the last 2 days" instead of a generic miss.
- **The system prompt is honest that "unusual" cannot be judged yet** — no
  classifier exists until Phase 4. It now says so and offers the label filter
  instead of guessing.
- **New: user-editable standing instructions**, not in the build plan, added
  on request. `instruction.add` / `list` / `remove` — free-form behavioural
  rules ("keep replies short", "always ask before X") taught via chat, stored
  in a new `customInstructions` table, rendered into every planning prompt.
  Capped at 20 per user (they cost tokens on every message). The prompt states
  explicitly that these tune tone/workflow and **cannot** grant a tool that
  does not exist or override the SCOPE/approval rules — a saved instruction
  cannot talk the assistant into a capability it structurally lacks.
- Fixed a bug caught in testing: `instruction.add`'s confirmation echoed an
  empty string — the router returned only the new id, not the text, so
  `outcomes.ts` had nothing to render. The stored row was always correct; only
  the confirmation message was blank.

### Fix — hallucinated capability claims, missing email tools, no NL connect

Reported: the bot claimed to be "investigating the OAuth error" and "updating
the configuration" — capabilities it does not have. Separately, "what's new in
my mailbox" got "I do not have access," and "connect my mailbox" in plain
language did nothing (only the `/connect` command worked). Traced with a new
durable audit query rather than `bunx convex logs` (which only tails forward,
never backfills): the connection had actually succeeded and synced 4 messages
— the model's diagnosis of a "misconfigured redirect URI" was invented.

- **`convex/lib/scope.ts` — a deterministic backstop on the model's own
  claims.** The system prompt is the primary fix (a new SCOPE section stating
  plainly: no code, no infrastructure, no Google Cloud Console, no Calendar/
  Drive/Linear/WhatsApp/send — state what an error literally said and stop).
  `guardReply` is defense-in-depth behind it: a narrow pattern match on
  self-referential claims of ongoing external work ("I am investigating /
  fixing / updating the [config/oauth/code/…]"), which replaces the whole
  reply with an honest boundary statement. Mirrors the project's existing
  untrusted-content pattern — prompt hardening is the seatbelt, structural
  constraint is the crash structure — applied to the model's own narration
  instead of to attacker content.
- **Email read tools** (`account.connect_link`, `email.list_recent`,
  `email.search`, `email.get_message`). Phase 3's build plan specified these
  and I never built them — sync and storage worked, but there was nothing for
  the model to call, so it had no way to answer "what's in my mailbox" except
  by guessing. All read-only, all `consequential: false`, results rendered
  deterministically (no model call touches email content — the Phase 3
  security gate holds).
- **`/connect` now works from plain language too.** `account.connect_link` is
  a tool like any other; "connect my work mail" resolves a label and returns a
  link exactly like the slash command does.
- **The planning prompt states connected mailboxes as fact.** Previously the
  model had no way to know what was already connected and had to guess.
- **Gmail snippets are cleaned.** Raw snippets carried unescaped HTML entities
  (`&#39;`) and zero-width padding characters some senders use — both render
  as garbage in Telegram. Decoded and stripped in the normalizer.
- `debug:recentAudit` / `debug:oauthStateRows` — durable, queryable incident
  history. `bunx convex logs` only tails from the moment you run it and cannot
  answer "what happened five minutes ago."

### Phase 3 — One Gmail, read-only, including spam

- **OAuth flow.** `/connect <label>` in Telegram mints a single-use, 10-minute
  nonce and returns a link. `GET /oauth/google/start` refuses to redirect
  without a live nonce — every `.convex.site` route is public, so the nonce IS
  the authorization, and a stranger cannot attach their mailbox to the owner's
  account. `GET /oauth/google/callback` consumes the nonce atomically, so a
  replayed callback finds nothing.
- **Envelope encryption** (`convex/security/crypto.ts`). AES-256-GCM through
  Web Crypto — no Node runtime, no dependency. Refresh tokens never touch an
  env var; the ciphertext, IV and auth tag live on the `connectedAccounts`
  document. Decryption happens only in an action, at the moment of use.
- **`gmail.readonly` and nothing else.** Tests assert the scope list contains
  no `send`, `modify`, `compose`, or `https://mail.google.com/`.
- **Spam is included.** `includeSpamTrash: true` on every list call, and the
  raw `labelIds` array is stored so `SPAM` and category labels stay queryable.
- **Deterministic normalization** (`connectors/gmail/normalize.ts`, pure, 20
  tests). Headers, address lists that survive a comma inside a quoted name,
  base64url that survives UTF-8, SPF/DKIM/DMARC verdicts for Phase 4's spoof
  resistance, attachment metadata without downloading, and a 32 KB body cap.
  No LLM anywhere in this phase.
- **`/reconnect` is built now, not later.** A Testing-mode Google app expires
  refresh tokens every 7 days; that is the normal weekly path, so an
  `invalid_grant` marks the account `NEEDS_REAUTH` and Telegram gets told how
  to fix it.
- **`(accountId, providerMessageId)` uniqueness** by index plus check-then-
  insert in one transaction. Re-syncs patch `labelIds` — the one field that
  legitimately changes.
- **Sync cron**: every 10 min while awake, 30 overnight (UTC-shifted for WAT).
  One account failing does not stop the others.
- New commands: `/connect`, `/reconnect`, `/accounts`, `/sync`.
- `debug:cryptoSelfTest` — proves ENCRYPTION_KEY round-trips on a deployment
  and that the plaintext does not appear in the stored ciphertext.

### Fix — silently discarded tool calls

The assistant reported doing things it had not done: "I've set up the project,
created the task and scheduled your reminder" when only the reminder existed,
with `/tasks` empty afterwards.

- **The tool catalogue now states argument TYPES.** It previously rendered
  field *names* only — `memory.upsert_project(name, status?, priority?)` — so
  "Momentum Logistics is high priority" produced `priority: "high"` against a
  bare `z.number()`, which `parseToolPlan` rejected. Every field now carries a
  `.describe()` and `describeCatalog()` renders it.
- **Arguments are coerced to what a model actually emits.** `"high"` → `2`,
  `"in-progress"` → `IN_PROGRESS`, `"2"` → `2`. Genuine nonsense is still
  rejected.
- **Rejections reach the user and invalidate the planned reply.** They were
  logged and dropped, so the plan's optimistic reply stood unchallenged.
  `renderOutcomes` now takes them and reports `⚠️ Couldn't do <tool> — <why>`.
- **Tasks can be addressed by title.** `task.block` / `complete` / `update` /
  `unblock` accept `taskTitle` as well as `taskId`, resolved in code by
  `tasks.findByTitle`. A model cannot know the id of a task it is creating in
  the same plan, which is exactly what "I need to do X, and I'm blocked on Y"
  requires.
- **Pending reminders are in the planning context, with ids**, so cancelling
  one no longer needs a `reminder.list` round-trip.
- **The voice transcript is no longer echoed** in the reply. It is still
  persisted on the message row.
- Planning prompt now states that one message often means several calls, that a
  mistyped argument is discarded, that `reply` is shown verbatim and must not
  claim un-called actions, and that a bare day means 09:00.
- `debug:planOnly` — run the planning pass for any text and see the proposal,
  the rejections, and (with `execute: true`) the outcomes.

### Fix — Gemini-only, model ladders, working voice notes

- **Halved the model calls per message.** Conversation ran `PLAN_TOOLS` and
  then a second `CHAT_REPLY` call to narrate the tool results — two flash-tier
  requests per inbound message, which is what exhausted the free tier after two
  or three of them. Tool results are now rendered deterministically by
  `convex/lib/tools/outcomes.ts`. **One model call per message.**
- **`PLAN_TOOLS` moved from `REASON` to `CHEAP_STRUCTURED`.** It emits a tool
  proposal against a fixed catalogue, which is what the tier is for, and Gemini
  quota buckets are per-model — so this also moves the per-message cost onto a
  different bucket from chat and transcription.
- **Voice notes work.** `handleVoice` downloads the file, transcribes it
  through an inline-audio Gemini call, persists the transcript, and runs it
  through the ordinary pipeline. The reply echoes what was heard, so a
  mishearing is distinguishable from a misunderstanding.
- **Model fallback ladders, verified against the live key.** Every rung was
  probed individually; `gemini-2.5-flash` and `gemini-2.5-flash-lite` **404 on
  this key** despite appearing in the 16 Aug model list, so the ladders stop at
  `gemini-3-flash-preview` / `gemini-3.1-flash-lite` with a floating
  `gemini-flash-latest` alias as the final backstop.
- **Gemini only.** `OPENAI_*` and `ANTHROPIC_*` removed from both deployments
  and from `.env.dev` / `.env.prod`. The provider implementations stay in the
  tree — a key is all it takes to re-enable either.
- **Quota exhaustion reads like a sentence.** `AllProvidersFailed` carries a
  `quotaExhausted` flag; Telegram gets "I'm out of AI quota for the moment",
  and the aggregate detail stays in the logs and `auditLogs`.
- **`REQUIRED_NOW`** now covers `GEMINI_MODEL_CHEAP_STRUCTURED` and
  `GEMINI_MODEL_TRANSCRIBE`, which the running code reads on every message.
- **`scripts/test-transcription.sh`** — synthesises speech, encodes real
  Opus/Ogg, and runs it through the live TRANSCRIBE tier.
- `debug:pingAI` gained `model` (bypass the ladder, probe one model) and
  `audioBase64` / `audioMime`.

### Phase 2 — Structured memory, tasks, reminders, tool router

- **Tool router** (`convex/tools/router.ts`, `convex/lib/tools/`). Twelve
  tools across projects, people, tasks, blockers and reminders. The model
  emits a typed proposal; the router Zod-validates it, refuses anything
  `consequential` without an approval, resolves names to ids in code, executes,
  and writes an `auditLogs` row either way. Invariant I-1 in code.
- **Exact-time reminders** (`convex/model/reminders.ts`,
  `convex/reminders.ts`). `ctx.scheduler.runAt` schedules the delivery
  function at the instant it is due — no polling loop, second precision, and
  cancelling cancels the job rather than flipping a status column. The job id
  is stored on the row for cancel, reschedule, and Phase 18's `[ Stop ]`.
- **Hourly reconcile sweep** (`convex/crons.ts`). Catches deliveries our own
  bugs could drop. Finds nothing when everything works; that is the point.
- **Two-pass orchestration** (`convex/assistant.ts`). Pass 1 plans against a
  10-turn conversation window plus the user's live projects and open tasks;
  the router executes; pass 2 composes the reply from tool results, which
  enter the prompt as untrusted data. A plan calling no tools skips pass 2, so
  ordinary chat costs one model call, not two.
- **Timezone-correct instants** (`convex/lib/time.ts`). Model-supplied ISO
  strings resolve against `USER_TIMEZONE` via `Intl`, DST included, and throw
  rather than yielding `NaN`.
- **Commands**: `/tasks`, `/blocked`, `/reminders` alongside `/status`,
  `/whoami`, `/help`, `/start`. All deterministic — no model call.
- **Domain model**: `convex/model/{projects,people,tasks,preferences}.ts`.
  Every mutation re-checks ownership; an id from the model is a proposal, not
  proof of access.

### Phase 1 — Telegram ↔ core ↔ AI ↔ Convex

- **Telegram webhook** (`POST /webhooks/telegram`). Verifies the
  `X-Telegram-Bot-Api-Secret-Token` header, serves exactly one owner (anyone
  else gets silence and an audit row), and returns 200 in milliseconds by
  handing off to `ctx.scheduler.runAfter(0, ...)`. The body is narrowed field
  by field from `unknown`.
- **AI provider registry** (`convex/ai/`, `convex/lib/ai/`). Task → tier →
  per-provider model. A provider is configured purely by the presence of its
  API key, so switching is `bunx convex env set` with no code change and no
  redeploy. On a retriable failure the chain falls through to the next
  provider.
- **Three live providers**, not stubs: Gemini (`generateContent`), OpenAI
  (Responses API), Anthropic (Messages API). The build plan specified stubs
  for the latter two; all three keys exist, so all three are implemented.
- **Quota exhaustion is retriable** (`convex/lib/ai/errors.ts`). A funded-out
  provider is a configuration problem, not a bug — the chain moves on.
- **Message persistence** (`messages` table) for both directions.
- **`/health` means something again**: `REQUIRED_NOW` now lists every variable
  the running code actually consumes.

### Tooling

- Added `typescript` and `@types/bun` as devDependencies. `bun run typecheck`
  had no compiler to run before this.

## [0.1.0] — Phase 0

- Convex scaffold, full target schema (Appendix F), `/health`, append-only
  `auditLogs`, pure-`convex/lib` config module and its unit tests. (`d457315`)
