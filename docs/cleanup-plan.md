# PA cleanup plan

Audit date: 2026-10-15. Scope: everything in `/Users/thekiwidev/work/me/pa`.
Goal: turn a capable-but-noisy tool runner into an assistant that talks like a person, knows the context it is in, and nudges you before you ask.

**By the end you'll have:** one short behaviour spec the bot obeys, a smaller prompt, one task store, alerts you can reply to naturally, a morning check-in instead of a report, calendar nudges, and a planner model that actually reasons.

---

## 0. Before anything: the repo is in a risky state

- **~5,500 lines are uncommitted** (32 modified files, plus new `lib/tasks`, `lib/calendar`, `connectors/gcal`, `gdrive`, Pub/Sub, and most of `docs/`). One bad checkout loses the Linear backend, Calendar, Drive and Gmail push.
- **What you see on Telegram is older than the working tree.** Your search transcript uses a `• sender — subject` + snippet layout; the local `renderEmailList` (`convex/lib/tools/outcomes.ts:152`) renders `**N emails** · mailbox · window`. So some of what you saw is already changed locally and never shipped, and some is still broken.
- `AI_PROVIDER_PRIORITY=openrouter` in `.env.local` / `.env.dev`, so dev may not even be running on Gemini.

**Do first:** commit the working tree on a branch (`checkpoint/pre-cleanup`), then confirm what dev/prod is running.

---

## 1. Root causes, issue by issue

| What you saw | Why it happens (checked in code) |
|---|---|
| **Morning brief is a long report** | The `morning_brief` skill literally orders it: *"intentionally comprehensive… NOT a minimal executive summary… Do not hide information merely to keep the response short"* (`convex/lib/skills.ts:262`, ~730 lines, 36 sections). The model obeyed. The brief also still says *"There is NO calendar in this build"* (`convex/briefs.ts:206`, `:239`) even though Calendar shipped, so it can never say "your first meeting is at 10". |
| **Alerts feel weird / noisy** | The card is a form, not a sentence: `HIGH · primary / From: / Subject: / Why it matters:` (`convex/notify.ts` `composeCard`). The classifier prompt (`convex/lib/email/classification.ts:79`) has **no rubric** for CRITICAL vs HIGH and **no knowledge of you**, so a transfer receipt you made yourself scores HIGH. The card also never shows *when* the mail arrived. |
| **"When did this come in?" returned a pile of search results** | Three gaps stack up. (1) Telegram's `reply_to_message` is never read anywhere in `convex/` (grep finds nothing), so replying to a card carries no link to the email. (2) Alert cards are saved to `notifications`, not `messages`, so the conversation history the planner sees (`messages.recentForUser`, last 10 turns) doesn't contain the alert at all. (3) With no context, the planner's only move is `email.search`, and search results are rendered as a full deterministic list by design. |
| **Search pastes every result instead of the one you meant** | By design: `renderEmailList` prints every hit, and the model may only add "what stands out" under it (`listSummarySystemPrompt`, `convex/lib/prompts/assistant.ts`). Nothing ranks results against your request or picks a best match. |
| **"What are my tasks?" doesn't know where to look; updates don't stick** | (1) **Split brain:** `pickBackend()` picks Linear only while the Linear account is `ACTIVE`; if the key lapses it silently falls back to the local `tasks` table, and writes land there instead. (2) Projects and blockers always stay in Convex, even with Linear on, so the brief mixes two stores (`briefs.ts` reads `tasks.openBlockers` from Convex). (3) Two tool families hit Linear (`task.*` and `linear.*`). (4) Every Linear write is **staged** behind an Apply tap (`stageLinearUpdate`, `router.ts:2446`); if you don't tap, nothing changes, and the reply says "queued", which is easy to miss. (5) Tasks are only loaded when your message contains a task keyword (`mentionsTasks`). |
| **Forgets things after a while** | Only the last **10 messages** are visible (`CONVERSATION_TURNS = 10`, `assistant.ts:36`). There is no running summary of the conversation. Long-term facts are saved only if the model chooses one of **three** stores (`context.set`, `instruction.add`, Notion `note.create`), and Notion is only reachable through an explicit search. The `memories` table exists and nothing uses it. |
| **No "meeting in 30 minutes"** | No scheduled job looks at the calendar. `crons.ts` has only mail sync, reminder reconcile, brief safety net, and the watch renewal. Phases 13 and 14 (daily focus, check-ins) were never started. |
| **"Am I free Thursday?" isn't smart** | `googleAccountFor()` (`router.ts:2252`) takes the **first** Google account with calendar scope and reads only that one calendar. Windows are only `today / rest_of_today / tomorrow / week / next_week` (`lib/calendar/window.ts:111`), so "Thursday" can't be asked directly. No near-miss warnings ("free 2–4, but you have something at 4:15"). |
| **Generally doesn't "get" the conversation** | The planner, the call that decides everything, runs on the **cheapest tier** (`PLAN_TOOLS → CHEAP_STRUCTURED` = `gemini-3.5-flash-lite`, `lib/ai/tiers.ts`). It gets one shot to pick all tools before seeing any result, using JSON-in-text (no native function calling) against ~60 tools and a system prompt that is mostly the `SCOPE` wall (`prompts/assistant.ts`). That prompt also contradicts itself: it opens *"projects, tasks, reminders, people, reading Gmail… That is the complete list"* and later lists *"Calendar"* as a capability with no tool. |

**Formatting rules you wrote down:** the only format rules in the repo are `TELEGRAM_FORMAT_CONTRACT` (`convex/lib/prompts/format.ts`): bold not headings, `- ` bullets, no tables, no `---`. Your own rules are most likely saved inside the bot (custom instructions or skills edited in chat, which live in Convex, not in git). I couldn't read the Convex database from here. Run `bunx convex run debug:rawInstructions '{}'` and paste the output, and I'll fold them into the spec.

---

## 2. Gemini or OpenAI?

**Recommendation: use OpenAI for the planner and reply writer while testing, and keep Gemini for classification and voice.**

- The main problem isn't the vendor, it's that the planner is a lite model doing one-shot JSON. Fixing that means **native tool calling in a short loop** (call a tool, see the result, decide again). OpenAI's function calling with strict JSON schemas is the most predictable option for that, and `convex/ai/providers/openai.ts` already uses the Responses API, so adding tools is a small extension.
- Gemini Flash-Lite is fine and nearly free for the background jobs (importance classification, voice transcription), which run far more often.
- Swapping is mostly config (`AI_PROVIDER_PRIORITY`, `AI_ROUTE_PLAN_TOOLS`, `OPENAI_MODEL_REASON`), because providers are already pluggable. The cost is a few cents a day for one user. Re-check once the loop exists; if Gemini's full Flash does as well in A/B tests, switch back.

---

## 3. The plan, in order

### Phase A — Documentation first (no code)

1. **`docs/BEHAVIOUR.md`: the behaviour spec**, one page, written as examples of what you'd see on Telegram:
   - *Voice:* a PA texting you. Short messages, at most ~5 lines unless you ask for more. One thing at a time.
   - *Alert:* `Polaris says your ₦150,000 transfer to Adedotun Gabriel went through, 9:42 this morning (primary). Want me to file it?` One sentence on who, what and when. Buttons stay.
   - *Morning check-in:* `Morning Adedotun. First thing: finish THE-89. You've got a call at 11. One email needs a reply (Mira, about invoice).` Then wait for your reply.
   - *Search:* return **the** best match plus one line on why it fits. "Not that one" moves to the next best match.
   - *Follow-ups:* a question about something just shown gets answered from that thing's own data (date, sender, amount), with no new search.
   - *Availability:* checks all calendars, gives a yes/no, then names any clash within ±60 min.
   - *Hard rules:* nothing is sent without your tap, and a reply always goes from the mailbox the email came to.
2. **`docs/ARCHITECTURE.md` refresh:** one task store, one memory model, the agent loop, the proactive scheduler. Mark `STATUS.md`, `ROADMAP.md` and the old build plans as history.
3. **Rewrite prompts against the spec:**
   - Planner system prompt: cut `SCOPE` from about 180 lines to about 40. Capabilities come from the tool list itself, not prose.
   - `morning_brief` skill: from 730 lines down to about 30, built around the "first thing" check-in.
   - Classifier: add a rubric plus your context (self-initiated bank receipts and promos are LOW; clients, interviews, money *requested from* you and security are HIGH).
   - Alert copy and search copy templates.

### Phase B — Code, highest impact first

| # | Change | Fixes |
|---|---|---|
| 1 | **Conversation context.** Read `reply_to_message`; store every alert, brief and card in `messages` with a `ref` (`emailMessageId`, `eventId`, `taskId`); show the referenced object in the planner prompt. | "When did this come in?", follow-ups in general |
| 2 | **Planner on a real model with native tools and a loop** (max 3 steps). Provider interface gains `tools`; OpenAI first. | Context sense, search choosing, fewer wrong tools |
| 3 | **Search returns the best match.** Rank results against the request, show one with a reason, keep the rest in a "next" cursor. The full list only on "show all". | Search dump |
| 4 | **Alerts rewritten.** Sentence-style card with arrival time; classifier rubric plus user context; "Not important" teaches a sender rule automatically. | Noisy and weird alerts |
| 5 | **One task store: Linear.** Remove the silent Convex fallback (an expired key gives an error you see, not a quiet switch). Move blockers and projects to Linear labels and projects. Retire `task.*` vs `linear.*` duplication. Low-risk edits to *your own* issues (status, priority) apply immediately with an Undo button; only creates, deletes and bulk changes need Apply. | Tasks lost or not updated |
| 6 | **Morning check-in.** Short message: the first thing to do, today's first meeting, at most 2 items needing you. The rest arrives on request ("what else?"). | Brief overload |
| 7 | **Calendar everywhere.** Query all connected Google calendars; parse "Thursday", "next Tue 3pm"; free/busy with near-miss warnings. | "Am I free?" |
| 8 | **Proactive nudges.** A job every 5 min looks 30 min ahead and pings once per event (dedup like alerts); optional end-of-day check-in. | Meeting reminders |
| 9 | **Memory.** A rolling conversation summary saved every N turns and always in the prompt; merge `context.set` and `instruction.add` into one "remember" tool; Notion stays for notes. | Forgetting |

Each step gets tests in `tests/unit` before code, plus a `CHANGELOG.md` / `MEMORY.md` entry, as `CLAUDE.md` requires.

---

## 4. What stays as is

- Approval before any email goes out (`model/approvals.ts`, hash-bound, single-use).
- The mailbox for a reply comes from the source message in code, never from the model.
- The seven invariants in `CLAUDE.md`.
- Gmail push and sync, spam scanning, Drive read, Notion notes, voice, and image reading all work. This plan is about behaviour, not new connectors.

## 5. Recommended first step

Commit the current working tree to a checkpoint branch, then write `docs/BEHAVIOUR.md` (Phase A.1). Every prompt rewrite and code change after that is checked against it.
