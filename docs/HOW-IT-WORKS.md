# How it works

**Who this is for:** you, sitting down to change something.

This is the mechanical document. It follows one Telegram message all the way
through the system, then breaks out the four subsystems you are most likely
to touch — **prompting**, **the AI provider chain**, **tools**, and **email
search** — with the exact file and line to open for each.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for *why* it is shaped this way.
Read this for *where the code is*.

---

## 1 · The one-message lifecycle

Every single inbound Telegram message takes this path. There is no second
path. Learn this and you can find anything.

```
Telegram servers
   │  POST (JSON update)
   ▼
convex/http.ts        /webhooks/telegram
   │  ① verify X-Telegram-Bot-Api-Secret-Token   → 401 if wrong
   │  ② fromId must equal TELEGRAM_OWNER_ID      → silence + audit row
   │  ③ narrow the update to a known shape       → parseTextMessage etc.
   │  ④ ctx.scheduler.runAfter(0, …) and return 200 IMMEDIATELY
   ▼
convex/assistant.ts   handleMessage  (internalAction)
   │  persist inbound message row
   │
   ├── text starts with "/"  → handleCommand()  ── deterministic, NO model call
   │
   └── otherwise → converse()
                     │
                     │  ── PASS 1: PLAN ──────────────────────────
                     │  gather context (7 parallel queries)
                     │  build system prompt   lib/prompts/assistant.ts
                     │  runTask("PLAN_TOOLS")  ai/registry.ts
                     │  model returns  { reply, tools: [...] }   ← a PROPOSAL
                     │
                     │  parseToolPlan()        lib/tools/plan.ts
                     │    Zod-validate every call; drop unknown tools
                     │
                     │  ── EXECUTE ────────────────────────────────
                     │  executeToolCall() per call   tools/router.ts
                     │    approval gate → resolve names → run → audit
                     │
                     │  renderOutcomes()       lib/tools/outcomes.ts
                     │    DETERMINISTIC text. no model. this is the default reply.
                     │
                     │  ── FOLLOW-UP (conditional) ────────────────
                     │  only if a tool returned content the planner
                     │  could not have known → ONE more planning pass
                     │
                     │  ── PASS 2: COMPOSE (conditional) ──────────
                     │  only if a SKILL matched this message
                     │  runTask("COMPOSE_REPLY") with tool results
                     │  passed as UNTRUSTED data
                     ▼
   sendMessage()      convex/channels/telegram.ts
     markdown → HTML → split at 4096 → POST sendMessage
   persist outbound message row
```

### Cost, in model calls

| Turn | Calls |
|---|---|
| `/tasks`, `/status`, any slash command | **0** |
| "remind me to call Paul at 4" | **1** (plan only) |
| "what's in my inbox" (matches `check_email` skill) | **2** (plan + compose) |
| "read this link and save it to notes" | **3** (plan + follow-up plan + compose) |

That escalation is deliberate and bounded — see `converse()` in
[`convex/assistant.ts`](../convex/assistant.ts). There is no agent loop. There
is never a third planning round.

---

## 2 · Prompting — what the model actually receives

> This is the section you asked for most directly. Every string the model
> sees is built in **pure functions** under `convex/lib/prompts/`, with no
> `ctx` and no I/O, precisely so you can print them and unit-test them.

### 2.1 The three prompts that exist

| Prompt | Built by | Used when |
|---|---|---|
| **Planning** | `planningSystemPrompt()` — [`lib/prompts/assistant.ts`](../convex/lib/prompts/assistant.ts) | every non-command message |
| **Compose** | `skillComposeSystemPrompt()` — same file | a skill matched **and** tools ran |
| **TL;DR-only** | `tldrOnlySystemPrompt()` — same file | user asked for an email's **full** body |

Plus small task-local prompts defined at their call site as plain constants:
`TRANSCRIBE_SYSTEM`, `READ_IMAGE_SYSTEM`, `READ_DOCUMENT_SYSTEM` (all in
`convex/assistant.ts`), and `CLASSIFICATION_SYSTEM_PROMPT`
(`lib/email/classification.ts`).

### 2.2 The planning prompt, section by section

`planningSystemPrompt()` assembles these in order. Nothing else reaches the
model as instruction.

```
You are <name>'s personal assistant.  ← 2 lines of tone
Current time: <formatted> (<tz>)      ← formatInstant(), lib/time.ts
Known projects:        ← from model/projects.listActive  (max 15)
Open tasks:            ← from model/tasks.list           (max 15, with IDs)
Pending reminders:     ← from model/reminders.listPending (with IDs)
Connected mailboxes:   ← from model/connectedAccounts.listForUser
Active skills:         ← keyword-matched, see §5
WHAT YOU KNOW ABOUT THE USER:   ← buildKnowledgeBlock(), lib/prompts/knowledge.ts
STANDING INSTRUCTIONS:          ← same block
Tools available:       ← describeCatalog(), lib/tools/catalog.ts  (GENERATED)
SCOPE — what you actually are:  ← the long const in prompts/assistant.ts
Reply with a single JSON object…  ← OUTPUT_CONTRACT
FORMAT — you are writing for Telegram…  ← TELEGRAM_FORMAT_CONTRACT
```

The **user's message** is *not* in the system prompt. It goes in `input`:

```ts
runTask("PLAN_TOOLS", {
  system,                                   // everything above
  input: `Conversation so far:\n${transcript}\n\nRespond to the last user message.`,
  maxOutputTokens: 1500,
});
```

`transcript` is the last 10 turns, rendered by `renderConversation()` as
`User: …` / `Assistant: …` lines.

### 2.3 Printing the real prompt

Do not read the code and imagine the string. Print it.

```bash
bunx convex run debug:planOnly '{"text":"what did FairMoney send me?"}'
```

That runs the planning pass against the live deployment and returns the raw
model output, the calls that survived Zod validation, and the ones that were
rejected and why — **without executing anything**. Add `"execute": true` to
actually run the router.

For a purely local view, the prompt builders are pure, so:

```bash
bun test tests/unit/assistant-prompt.test.ts
```

…and to eyeball the tool block the model sees:

```ts
// scratch.ts
import { describeCatalog } from "./convex/lib/tools/catalog";
console.log(describeCatalog());
```
```bash
bun run scratch.ts
```

### 2.4 Where to edit what

| You want to change | Edit |
|---|---|
| The assistant's tone / persona | first two lines of `planningSystemPrompt()` |
| What it says it can and cannot do | the `SCOPE` const, same file |
| The JSON response shape | `OUTPUT_CONTRACT`, same file |
| Telegram markdown rules | `TELEGRAM_FORMAT_CONTRACT` — [`lib/prompts/format.ts`](../convex/lib/prompts/format.ts) |
| How user facts/rules are rendered | `buildKnowledgeBlock()` — [`lib/prompts/knowledge.ts`](../convex/lib/prompts/knowledge.ts) |
| A tool's description as the model reads it | `TOOL_META[name].description` — [`lib/tools/catalog.ts`](../convex/lib/tools/catalog.ts) |
| A tool's argument hints | `.describe()` on the Zod field, same file |
| A whole procedure (email checking, briefs) | `DEFAULT_SKILLS` — [`lib/skills.ts`](../convex/lib/skills.ts) |

**Rule of thumb:** if it is about *what a tool is*, it belongs in the catalog,
not in `SCOPE`. `SCOPE` is for what the assistant *is not*.

### 2.5 The untrusted-content frame — do not route around it

External text (email bodies, link captions, tool results, file contents) is
**never** concatenated into `input`. It goes through `untrusted`:

```ts
runTask("COMPOSE_REPLY", {
  system: skillComposeSystemPrompt(...),
  input: `The user said: ${text}`,
  untrusted: [{ label: "tool_results", content: deterministic }],
});
```

`buildPrompt()` in [`lib/ai/prompt.ts`](../convex/lib/ai/prompt.ts) wraps each
block:

```
<untrusted source="tool_results">
…content…
</untrusted>
```

preceded by a fixed warning. The *real* defence is not the warning — it is
that the output schema of a task that reads untrusted content has no field
capable of expressing an action. Keep it that way when you add a task.

---

## 3 · The AI layer — tasks, tiers, providers, models

### 3.1 Never name a model in feature code

```
call site names a TASK      →  TASKS["PLAN_TOOLS"]        lib/ai/tiers.ts
TASK maps to a TIER         →  "CHEAP_STRUCTURED"
TIER + PROVIDER → env var   →  GEMINI_MODEL_CHEAP_STRUCTURED
env var holds a LADDER      →  "gemini-3.5-flash,gemini-flash-latest"
```

The four layers, each in one file:

| Layer | File | What it decides |
|---|---|---|
| Task → tier | [`lib/ai/tiers.ts`](../convex/lib/ai/tiers.ts) | which class of model this job needs |
| Provider ordering | [`lib/ai/resolve.ts`](../convex/lib/ai/resolve.ts) | which vendors are eligible, in what order |
| Failure classification | [`lib/ai/errors.ts`](../convex/lib/ai/errors.ts) | retriable (fall through) vs fatal (stop) |
| Execution + fallback | [`ai/registry.ts`](../convex/ai/registry.ts) | the loop that actually calls providers |

The first three are **pure** and unit-tested (`tests/unit/provider-*.test.ts`,
`model-chain.test.ts`). Only `registry.ts` and `ai/providers/*` touch the
network.

### 3.2 The six tiers

| Tier | For | Current tasks |
|---|---|---|
| `CHEAP_STRUCTURED` | classification, extraction, routing | `PLAN_TOOLS`, `CLASSIFY_IMPORTANCE`, `SUMMARIZE_THREAD` |
| `REASON` | planning, multi-step judgement | `CHAT_REPLY`, `EXTRACT_COMMITMENTS` |
| `DRAFT` | prose a human will read | `COMPOSE_REPLY`, `DRAFT_REPLY`, `SUMMARIZE_MEETING`, `COMPOSE_BRIEF` |
| `TRANSCRIBE` | audio → text | `TRANSCRIBE_VOICE` |
| `VISION` | images and PDFs → text | `READ_IMAGE`, `READ_DOCUMENT` |
| `EMBED` | Phase 17 only | (none yet) |

Note `PLAN_TOOLS` sits on `CHEAP_STRUCTURED`, not `REASON`. It emits
structured output against a fixed catalogue, and it fires on **every inbound
message** — putting it on `REASON` is what exhausted the Gemini free tier
after three messages. The comment in `tiers.ts` says so; keep it.

### 3.3 Resolution precedence

`resolveProviderChain(env, tier, task)` applies, in order:

1. explicit override at the call site (rare; the caller does it)
2. `AI_ROUTE_<TASK>` env var — moves one provider to the front
3. `AI_PROVIDER_PRIORITY` — comma-separated order
4. **key present AND tier supported** — the hard filter

A provider is "configured" purely by the presence of its API key. Adding one
is `bunx convex env set`, never a code change. Which tiers a provider can
serve is declared in `PROVIDER_CAPABILITIES` in `resolve.ts` — note OpenAI is
deliberately **not** listed for `TRANSCRIBE` (the Responses API has no audio
input part; claiming otherwise silently dropped voice notes).

If the chain resolves to nothing, `NoProviderAvailable` throws. It never
silently degrades.

### 3.4 The fallback loop

`runTask()` walks **providers**, and within each provider walks its **model
ladder**:

```
for provider in chain:
    for model in modelChain(provider, tier):
        try: return provider.run(...)
        catch: record failure, next model
throw AllProvidersFailed(task, failures, quotaExhausted)
```

Every failure is collected, not just the last. `AllProvidersFailed` carries
`quotaExhausted` so `userFacingError()` in `assistant.ts` can say
*"I'm out of AI quota, try again in a few minutes"* instead of dumping a
stack trace into Telegram.

`raiseForStatus()` in [`ai/types.ts`](../convex/ai/types.ts) is the single
place that decides retriable vs fatal — 429, any 5xx, or a body matching
`QUOTA_SIGNALS`. Every provider funnels through it so vendors cannot drift.

### 3.5 Switching to OpenAI — the actual steps

This is entirely an environment change. **No code edit is required.**

```bash
# 1. Give it a key. Presence of the key is what makes it "configured".
bunx convex env set OPENAI_API_KEY sk-...

# 2. Give it a model ladder per tier you want it to serve.
bunx convex env set OPENAI_MODEL_CHEAP_STRUCTURED "gpt-5-mini,gpt-5"
bunx convex env set OPENAI_MODEL_REASON           "gpt-5,gpt-5-mini"
bunx convex env set OPENAI_MODEL_DRAFT            "gpt-5"
bunx convex env set OPENAI_MODEL_VISION           "gpt-5"

# 3. Put it first in the priority order. Gemini stays as the fallback.
bunx convex env set AI_PROVIDER_PRIORITY "openai,gemini,openrouter"

# 4. Prove it.
bunx convex run debug:pingAI '{}'
bunx convex run debug:pingAI '{"task":"PLAN_TOOLS"}'
```

`pingAI` returns `served_by`, `model`, `chain` and `configured_models` — so
you can see which vendor actually answered, not which one you intended.

**Do not** point `TRANSCRIBE` at OpenAI. `PROVIDER_CAPABILITIES` excludes it;
voice notes will keep routing to Gemini even with `AI_PROVIDER_PRIORITY` set
to OpenAI-first, which is the correct behaviour.

To route **one task only** at OpenAI while everything else stays on Gemini:

```bash
bunx convex env set AI_ROUTE_COMPOSE_REPLY openai
```

To test one specific model with no ladder and no fallback:

```bash
bunx convex run debug:pingAI '{"model":"gemini-3.5-flash"}'
```

### 3.6 Adding a provider

1. Write `convex/ai/providers/<name>.ts` exporting an `AIProvider`
   (`id`, `run(req, model, apiKey)`). Copy `openai.ts` — it is the shortest.
   Call `raiseForStatus()` on every non-2xx. Build the prompt with
   `buildPrompt(req.input, req.untrusted)`; never concatenate yourself.
2. Add it to `PROVIDER_CAPABILITIES` in `lib/ai/resolve.ts` with an honest
   tier list.
3. Add it to the `PROVIDERS` map in `ai/registry.ts`.
4. Add `ProviderId` to the union in `lib/ai/resolve.ts`.
5. `bunx convex env set <NAME>_API_KEY … <NAME>_MODEL_<TIER> …`

---

## 4 · Tools — proposal, validation, disposal

### 4.1 The three files

| File | Role |
|---|---|
| [`lib/tools/catalog.ts`](../convex/lib/tools/catalog.ts) | **contract** — Zod schema + description + `consequential` flag |
| [`lib/tools/plan.ts`](../convex/lib/tools/plan.ts) | **proposal** — parse the model's JSON, validate, reject |
| [`tools/router.ts`](../convex/tools/router.ts) | **disposal** — approve, resolve ids, execute, audit |
| [`lib/tools/outcomes.ts`](../convex/lib/tools/outcomes.ts) | **render** — turn results into the sentence the user reads |

There are currently **46 tools**. `describeCatalog()` renders the catalog into
the prompt automatically — argument types included, because a bare
`z.number()` silently rejecting `priority: "high"` is exactly the failure that
made types load-bearing.

### 4.2 Adding a tool — the five edits

```ts
// 1. convex/lib/tools/catalog.ts — TOOL_SCHEMAS
"task.snooze": z.object({
  ...TASK_REF,
  until: INSTANT,
}).refine(needsTaskRef, TASK_REF_ERROR),

// 2. convex/lib/tools/catalog.ts — TOOL_META
"task.snooze": {
  description: "Push a task's due date out. Use when the user says 'not today', 'move it to Friday'.",
  consequential: false,        // true ⇒ needs an approval; see §4.4
  requiresAccountId: false,
  // contentIsUnknowable: true — set ONLY if the result is external content
  //                             the planner could not have predicted
},
```

```ts
// 3. convex/tools/router.ts — dispatch()
case "task.snooze": {
  // resolveTaskId turns taskTitle -> taskId in code. The model never
  // supplies a foreign key it invented.
  const taskId = await resolveTaskId(ctx, userId, a);
  await ctx.runMutation(internal.model.tasks.update, {
    userId,
    taskId,
    dueAt: toEpochMs(a.until as string, toolCtx.timezone),
  });
  return { snoozed: true, until: a.until };
}
```

```ts
// 4. convex/lib/tools/outcomes.ts — renderOne()
case "task.snooze":
  return `⏳ Snoozed until ${str(outcome.result, "until")}`;
```

```ts
// 5. tests/unit/tool-plan.test.ts — assert it parses, and that a bad arg is rejected
```

Then `bun run typecheck && bun test`. The `TOOL_META` type is
`Record<ToolName, ToolMeta>`, so forgetting step 2 is a compile error, not a
runtime surprise.

### 4.3 The rules that make this safe

- **Never let the model supply a foreign key it invented.** A task is
  addressed by `taskId` *or* `taskTitle`; the router resolves the title in
  code (`resolveTaskId`). Same for `projectName`, Linear's `stateName`, and
  emails' `senderOrSubject`.
- **An id is a proposal, not proof of access.** Every email path re-fetches
  the `connectedAccounts` row and checks `account.userId === userId` before
  returning anything. See `email.get_message` and `hydrateBodies()`.
- **Every call writes an `auditLogs` row** — ok, denied, or error. That table
  is append-only; there is no delete function and you must not write one.

### 4.4 The approval gate

Set `consequential: true` and the tool cannot execute without a **typed,
expiring, single-use approval bound to a hash of the exact payload**.

The flow, for `email.send_reply`:

```
email.create_draft
  → insert drafts row
  → payloadHash(accountId, anchorId, inReplyTo, to, cc, subject, body, attachments)
                                                        security/hash.ts
  → approvals.create(status: PENDING, expiresAt: now + APPROVAL_TTL_MINUTES)
  → scheduler.runAt(expiresAt, approvals.expire)
  → send a Telegram card with [Send] / [Discard]

user taps [Send]
  → http.ts parses callback_query → assistant.handleCallback
  → approvals.consume()          model/approvals.ts   ← the seven checks
  → only if ok: executeToolCall("email.send_reply")
```

The seven checks in `approvals.consume()` are the security core of the whole
project. Read them before touching anything nearby:

1. status is `PENDING` and not past `expiresAt` (races resolved in favour of expiry)
2. **hash recomputed from the LIVE draft** — an edit after approval voids it
3. `draft.accountId === message.accountId` — invariant I-3, in code
4. recipient containment — every recipient must appear in the original thread
5. mark `CONSUMED` **before** the connector is touched, cancel the expiry job
6. write the audit row **inside the transaction**, so it survives a failed send
7. nothing reads `AUTONOMOUS_SEND_ENABLED`, because that variable does not exist

A tap that fails any check never reaches `executeToolCall` at all.

---

## 5 · Skills — user-editable procedures

A **skill** is a named, full-authority procedure for one capability. Unlike
`customInstructions` (small tone rules, rendered on *every* message), a skill
is loaded only when its keywords appear in the user's message.

| Skill | Read by | Governs |
|---|---|---|
| `check_email` | chat planning + compose passes | questions *about* the inbox |
| `morning_brief` | [`convex/briefs.ts`](../convex/briefs.ts) | the daily digest |
| `draft_reply` | chat | choosing and presenting a draft |
| `compose_email_body` | [`tools/router.ts`](../convex/tools/router.ts) | writing the body that actually ships |

Selection is a **deterministic keyword match** — `relevantSkillNames()` in
[`lib/skills.ts`](../convex/lib/skills.ts) — so an ordinary turn spends
nothing on skills existing at all.

Crucially, matching runs against `intentText` (what the *user* typed), never
against attached content. A meeting transcript containing the word "email"
must not pull in the email procedure.

Defaults live in `DEFAULT_SKILLS`; a user row in the `skills` table overrides
one by name. Three ways to change one:

```
in chat:   "update the check_email skill: always show the date"   → skill.update
by file:   send a .md with the caption "skill: check_email"        → handleSkillDocument
in code:   edit DEFAULT_SKILLS in convex/lib/skills.ts             → affects the fallback only
```

Read the current effective content with `/skill check_email`.

**A skill can never grant a tool that does not exist, and can never waive an
approval.** That is enforced in `tools/router.ts`, not in any prompt.

---

## 6 · Worked example — changing email search

This is the walkthrough you asked for. Email search touches six files; here
is what each one owns.

### 6.1 The two search modes

```
email.search { query, deep? }
                │
     deep: false│ (DEFAULT)         deep: true
                ▼                        ▼
   model/emailMessages.search       gmail.deepSearch  (internalAction)
   ───────────────────────────      ────────────────────────────────
   Convex table only                LIVE Gmail API call
   what sync already stored         Gmail `q` syntax, no date bound
   = last 2 days (newer_than:2d)    max 25 results (DEEP_SEARCH_MAX)
   plain-text substring match       upserts anything new into Convex
   fast, free                       slower, quota-bearing
```

> **A subtlety worth knowing.** The catalog tells the model `query` is *plain
> text, not Gmail syntax* — true for the shallow path, which does a substring
> match in Convex. But in **deep** mode the same string is handed to Gmail as
> its `q` parameter, where `from:` and `label:` *do* work. The model is told
> the stricter rule because it cannot reliably tell which mode it is in. If
> you ever relax that, relax it in `TOOL_META["email.search"].description`
> and in `SCOPE` together.

`SYNC_WINDOW = "newer_than:2d"` and `MAX_PER_SYNC = 40` at the top of
[`convex/gmail.ts`](../convex/gmail.ts) define what "recent" means. Crons in
[`convex/crons.ts`](../convex/crons.ts) run the sync every 10 min while awake,
every 30 min overnight.

### 6.2 The full call path

| Step | File | Function |
|---|---|---|
| 1. tool contract, args, description | `lib/tools/catalog.ts` | `TOOL_SCHEMAS["email.search"]`, `TOOL_META` |
| 2. model proposes, args Zod-validated | `lib/tools/plan.ts` | `parseToolPlan` |
| 3. dispatch, label → accountIds | `tools/router.ts` | `case "email.search"`, `resolveAccountIds` |
| 4a. shallow query | `model/emailMessages.ts` | `search` |
| 4b. deep query | `convex/gmail.ts` | `deepSearch` |
| 5. shape one row | `tools/router.ts` | `summarizeEmail` |
| 6. render to text | `lib/tools/outcomes.ts` | `renderEmailList` |
| 7. hydrate real bodies (≤5 results) | `convex/assistant.ts` | `hydrateBodies` |
| 8. final prose | `lib/prompts/assistant.ts` + `lib/skills.ts` | `skillComposeSystemPrompt`, `check_email` |

### 6.3 "The output looks wrong" — pick the right file

| Symptom | Cause | Fix in |
|---|---|---|
| Bullet layout, `[SPAM]` flag, empty-result wording | deterministic renderer | `renderEmailList()`, `lib/tools/outcomes.ts` |
| Which fields appear per message (`from`, `subject`, `snippet`) | row shaping | `summarizeEmail()`, `tools/router.ts` |
| It summarised instead of showing the body | compose pass ran on a snippet | `hydrateBodies()` / `HYDRATE_LIMIT`, `convex/assistant.ts` |
| It says "no action required" about a dated event | compose-pass rules | `skillComposeSystemPrompt()`, `lib/prompts/assistant.ts` |
| Wrong search scope chosen (`deep` not used) | procedure | `DEFAULT_SKILLS.check_email` §1, `lib/skills.ts` |
| Passed `from:x@y.com` and got nothing | `query` is **plain text**, not Gmail syntax, in shallow mode | the `SCOPE` note + `TOOL_META` description |
| Found nothing that exists | 2-day sync window | `SYNC_WINDOW`, `convex/gmail.ts`, or use `deep:true` |
| Matching is too literal | substring match | `search` in `model/emailMessages.ts` |

### 6.4 Two matching algorithms, deliberately different

`model/emailMessages.ts` has both. Do not unify them without reading why:

- **`search`** — lowercase substring across `subject`, `fromAddress`,
  `fromName`, `snippet`, `bodyText`. Bounded: `.take(100)` per account,
  results capped at 25. Used for listing.
- **`findByFragment`** — **token scoring**, not substring. `"FairMoney clinic
  replay"` is not a substring of `"Missed FairMoney Clinic? Catch the replay
  🎧"`; word order and filler differ. It splits into tokens >2 chars, counts
  hits against `subject + fromAddress + fromName`, and ties resolve to the
  most recent message. Used to resolve *"that FairMoney email"* when no id
  exists — because email ids are deliberately never shown in chat.

### 6.5 A concrete change, end to end

**Goal:** make shallow search match the sender's *domain* too, and show the
received date in the list.

```
1. convex/model/emailMessages.ts — search()
   add the domain to the haystack array

2. convex/tools/router.ts — summarizeEmail()
   include receivedAt, formatted via formatInstant(…, timezone)

3. convex/lib/tools/outcomes.ts — renderEmailList()
   render the new field in the bullet

4. tests/unit/ — add a case for the domain match
   (search() is a Convex query, so test the pure matching helper you extract,
    or drive it with convex-test — see TESTING.md §5)

5. bun test && bun run typecheck
6. bunx convex dev --once
7. bunx convex run debug:planOnly '{"execute":true,"text":"any mail from acme?"}'
```

Step 7 matters. Unit tests cover pure modules; the router is not pure. Two
bugs in this codebase lived exactly in that gap.

---

## 7 · Where the untrusted boundary sits

Know these four, and you will not accidentally open a hole.

| Content | Enters as | Enforced by |
|---|---|---|
| Email bodies, tool results | `untrusted` block | `buildPrompt()`, `lib/ai/prompt.ts` |
| Image / PDF / audio bytes | `media` array | prompts whose only permitted output is a transcript |
| A photo's **caption** | the user's instruction | `readImagesAndConverse()` splits caption from extracted text |
| A pasted **link** | `link.read` | `assertFetchable()`, `lib/net/urlGuard.ts` — allow-listed platforms only, never a URL from an email |

The model's own reply is guarded too: `guardReply()` in
[`lib/scope.ts`](../convex/lib/scope.ts) replaces any reply claiming ongoing
work it cannot do ("I'm fixing the OAuth config") with a fixed sentence. A
prompt is advisory; this is the structural backstop behind it.

---

## 8 · The operator toolbox

Every one of these runs against the live deployment from your terminal.

```bash
# Is the provider chain working, and who answered?
bunx convex run debug:pingAI '{}'
bunx convex run debug:pingAI '{"task":"PLAN_TOOLS"}'
bunx convex run debug:pingAI '{"model":"gemini-3.5-flash"}'   # one model, no ladder

# What did the model actually propose for this message?
bunx convex run debug:planOnly '{"text":"remind me to call Paul at 4"}'
bunx convex run debug:planOnly '{"execute":true,"text":"..."}'  # really run it

# Prove the pieces
bunx convex run debug:cryptoSelfTest '{}'
bunx convex run debug:checkNotion '{}'
bunx convex run debug:connectLinear '{}'

# What happened recently?
bunx convex run debug:recentAudit '{}'
bun run logs

# What is this deployment configured with?
bunx convex env list
```

In Telegram: `/status` (providers, models, timezone), `/accounts` (mailboxes
and sync state), `/context` (facts on file), `/skills`, `/help`.

---

## 9 · Non-obvious things that will bite you

Collected from `MEMORY.md`. These are measured, not theoretical.

- **Cron expressions are UTC.** Lagos is UTC+1, no DST. 07:00 local is
  `0 6 * * *`. Write the offset in a comment on every line.
- **`convex/_generated/` is committed.** After adding or renaming a function
  file, run `bunx convex codegen` or typecheck fails against stale types.
- **HTTP actions serve from `.convex.site`**, not `.convex.cloud`.
- **Never `.filter()` on a growing table.** Always `.withIndex()`. Ceiling is
  32,000 documents scanned and 16 MiB read per transaction.
- **Bound every read** — `.take(n)` or `.paginate()`, never bare `.collect()`.
- **Stay in the default V8 runtime.** `"use node"` costs 512 MB against a
  20 GB-hour budget vs 64 MB. `fetch` works in V8 already.
- **Telegram: `allowed_updates` must include `callback_query`** or every
  button tap is silently dropped — no request, no log, nothing.
- **Convert markdown to HTML *before* splitting at 4096.** Splitting first can
  cut inside `**`, producing unbalanced HTML that Telegram 400s on.
- **A model asked to reproduce a long body verbatim will summarise it
  anyway.** Measured on `gemini-3.5-flash`. That is why full-body replies are
  emitted by the deterministic renderer and the model only appends a TL;DR.
- **A stored-but-unread config value fails silently.** `skills` and
  `userContext` both shipped with a writer and no reader. That is why
  `KNOWLEDGE_HEADING` exists and why `assistant-prompt.test.ts` asserts every
  prompt builder contains it.
