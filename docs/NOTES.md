# Notes — ideas, decisions, and things worth not forgetting

The running log of **what we said we would do, and why**. One entry per idea,
decision, bug or plan, newest first, dated.

## Why this file exists, and how it differs from the other three

| File | Answers | Written when |
|---|---|---|
| `CHANGELOG.md` | *what changed in the code* | the change ships |
| `MEMORY.md` | *why it was hard, and what bit us* | the change ships |
| `docs/STATUS.md` | *where we are against the plan* | after a milestone |
| **`docs/NOTES.md`** | *what we're thinking of doing, and where it stands* | **the moment the idea appears** |

The other three are all written **after** work happens. This one is written
**before** — it is the only place an idea can live while it is still just an
idea. If a thought is worth having twice, it goes here the first time.

## How to write an entry

```markdown
## 2026-09-06 · N-012 · [PLAN] Short title

**Status:** PLAN → IN PROGRESS → DONE (2026-09-20)
**Area:** ai-providers
**Raised by:** conversation on 2026-09-06

**The idea.** One paragraph, plain language.
**Why.** What makes it worth doing. Include the number if there is one.
**The goal.** What is true when this is finished.
**Next step.** The single next concrete action, or "waiting on X".
**Links.** [[other-note-id]], file paths, phase numbers.
```

**Statuses** — a note carries exactly one, and it is edited in place as it
moves. Never delete an entry; a rejected idea is worth as much as an accepted
one, and costs nothing to keep.

| Status | Means |
|---|---|
| `IDEA` | Raised, not committed to. May never happen. |
| `PLAN` | Decided. Not started. Has a next step. |
| `IN PROGRESS` | Being built now. |
| `DONE` | Shipped. Keep the date it landed. |
| `BLOCKED` | Cannot proceed. **Must name what it is waiting on.** |
| `BUG` | Something is wrong and known. |
| `FIX` | A bug with a decided remedy, not yet applied. |
| `NOTE` | A fact worth recording. No action attached. |
| `DROPPED` | Deliberately not doing. **Must say why** — this is the entry that stops us relitigating it in three months. |

**IDs** are `N-###`, assigned in order, never reused. They are what
`[[N-004]]` cross-references point at.

---

## 2026-09-06 · N-001 · [PLAN] Add xAI Grok as an AI provider

**Status:** PLAN
**Area:** ai-providers
**Raised by:** conversation on 2026-09-06

**The idea.** Add Grok (xAI) alongside Gemini, OpenAI, Anthropic and
OpenRouter. Early read is that it may be the strongest option for the
reasoning-heavy tasks — `PLAN_TOOLS`, `CHAT_REPLY`, `EXTRACT_COMMITMENTS`.

**Why.** Provider quality is the one variable that moves every feature at
once. The tool-planning call decides which tools run at all, so a better
model there fixes whole classes of "it did the wrong thing" without any
feature work.

**The goal.** `AI_PROVIDER_PRIORITY=grok,gemini,openai` routes work to Grok
with automatic fallback, and no feature code changes.

**What it actually takes.** Provider selection is already pure and
table-driven, so this is genuinely small:

1. Add `"grok"` to `ProviderId` — [convex/lib/ai/resolve.ts:3](../convex/lib/ai/resolve.ts:3)
2. Add a `PROVIDER_CAPABILITIES` row: `apiKeyVar: "XAI_API_KEY"`, and the
   tiers it truly supports — [convex/lib/ai/resolve.ts:19](../convex/lib/ai/resolve.ts:19)
3. Write `convex/ai/providers/grok.ts` against the same four-method
   interface the other four implement — `convex/ai/types.ts`
4. Register it in [convex/ai/registry.ts](../convex/ai/registry.ts)
5. `bunx convex env set XAI_API_KEY …` plus `XAI_MODEL_<TIER>` per tier
6. Document the vars in [docs/ENV.md](ENV.md)

**The trap to avoid.** Do **not** list a tier the provider cannot really do.
OpenAI was listed as `TRANSCRIBE`-capable, silently dropped the audio, and
answered a voice note confidently from an empty prompt — the comment at
[convex/lib/ai/resolve.ts:29](../convex/lib/ai/resolve.ts:29) is a scar. Verify
each tier with `debug:pingAI` before adding it to the row.

**Next step.** Confirm which xAI model to pin per tier, then write the
provider file.

**Links.** [[N-002]], `docs/ARCHITECTURE.md` §AI providers

---

## 2026-09-06 · N-002 · [NOTE] OpenAI credits are now available

**Status:** NOTE
**Area:** ai-providers · cost
**Raised by:** conversation on 2026-09-06

**The fact.** There is now OpenAI credit to spend. Until today the working
assumption — from the blueprint's §27 cost strategy — was Gemini free tier
only, and "do not buy OpenAI/Anthropic credits until measured usage or
capability gaps justify them".

**What changes.** OpenAI stops being a fallback-on-paper and becomes a real
routing target. Worth using where Gemini has actually been weak rather than
switching wholesale: `VISION` (image and PDF reading) and `DRAFT` are the
two where quality differences showed up in practice.

**What does NOT change.** Invariant 7 — cost is a design constraint, target
$0/month infrastructure. Credits are not a budget to burn; they are a reason
to re-measure. Per-tier routing (`AI_ROUTE_<TASK>`) exists precisely so one
expensive model can be used for one task without touching the rest.

**Next step.** None required. Consider `AI_ROUTE_READ_IMAGE=openai` and
compare against Gemini on a real receipt or screenshot before committing.

**Links.** [[N-001]]

---

## 2026-09-06 · N-003 · [DONE] Google Calendar and Google Drive are the next connectors

**Status:** DONE (2026-09-06) — both shipped, along with Phase 8. Inert until
each Google account is reconnected with the new scopes; see [[N-006b]].
**Area:** connectors
**Raised by:** conversation on 2026-09-06

**The idea.** Connect Calendar (build plan Phase 10) then Drive (Phase 11) —
the last two of Stage C, and the two the blueprint's north-star example
depends on: *"detect a buried interview email … locate the relevant document
in Drive … create a calendar item"*.

**Why now.** Email is stable through Phase 7, drafting and approval work, and
the morning brief exists. The brief is currently blind to the one thing a
morning brief is most obviously for — today's schedule.

**The goal.** *"What's my day tomorrow?"* answers from the real calendar in
WAT. *"Block 10–12 for Momentum Logistics"* just happens. *"Set up a call
with Paul Thursday at 2"* asks for approval first, because Paul is an
attendee. *"Find my latest CV"* returns candidates with dates, and I pick one.

**The rule that makes Calendar safe.** Consequentiality is about **attendees,
not about writing**. A solo block on your own calendar affects nobody and
needs no tap. An event with attendees, or editing an event you did not
create, goes through the approval desk. This is what keeps it useful instead
of nagging.

**The rule that makes Drive safe.** The model **narrows, you choose.** Never
let it pick an attachment silently — attaching the wrong CV, or a document
with a client's data, to a recruiter is the error class that would end trust
in the whole system. The file id goes into the approval hash so swapping the
attachment voids the approval.

**BLOCKER — this one is yours, not mine.** Both need new OAuth scopes
(`calendar.readonly`, then `calendar.events`; `drive.readonly`) added to the
consent screen in Google Cloud Console, and **every connected mailbox must
re-consent afterwards**. Code can be written and shipped before that; it
cannot work before that.

**What actually shipped.** Both, plus Phase 8 in the same pass. Calendar:
`list_events`, `get_event`, `create_event`, `apply_event`, `find_free_slots`.
Drive: `search_files`, `get_metadata`, `read_content`, read-only. Phase 8:
Pub/Sub push with full OIDC verification, history-based incremental sync,
daily watch renewal, and archive / mark-read / mark-unread / label.

One design decision worth recording, because the plan did not anticipate it:
"consequential iff attendees" could not be a flag, because `meta.consequential`
is static and read before dispatch. Solved the same way the Linear task
backend was — `calendar.create_event` is non-consequential and either creates
a solo event outright or HOLDS an invitation for approval, and
`calendar.apply_event` is the consequential half. A tool that proposes is not
consequential, whatever it proposes about.

**Next step.** Reconnect each mailbox — nothing else is outstanding.

**Links.** Phase 10 and Phase 11 in `docs/personal-ai-assistant-build-plan-v3-convex.md`,
`docs/build/PHASE-11-drive-context.md`, [[N-004]]

---

## 2026-09-06 · N-004 · [NOTE] The connectors still outstanding, in the order they are worth doing

**Status:** NOTE
**Area:** connectors
**Raised by:** conversation on 2026-09-06

Everything the blueprint §1 named as a connector, and where each stands:

| Connector | Phase | State | Worth doing when |
|---|---|---|---|
| Gmail | 3–8 | **Done**, push included | — |
| Google Calendar | 10 | **Done** | — |
| Google Drive | 11 | **Done**, read-only | — |
| Notion | unplanned | **Done** — notes and long-tail memory | — |
| Linear | 16 | **Done** — and now the task store | — |
| Social links | unplanned | **Done** — read a pasted post | — |
| Zoho | 15 | **Not started** | only if a Zoho mailbox actually matters |
| Outlook | 15 | **Not started** | same |
| WhatsApp | 19 | **DROPPED** — see [[N-009]] | never, unless Meta ships a personal-account read API |
| iMessage / Mac companion | 20 | **DROPPED** — see [[N-010]] | never, unless explicitly reconsidered |

**The honest read, updated 2026-09-07.** Every connector with a clear payoff
is now built. Zoho and Outlook are breadth with no current user — do not
build a mailbox nobody reads. WhatsApp and the Mac companion are both now
formally dropped rather than merely unscheduled.

**Links.** [[N-003]], `docs/STATUS.md`

---

## 2026-09-06 · N-005 · [NOTE] Tasks now live in Linear, with Convex as the fallback

**Status:** DONE (2026-09-06)
**Area:** tasks
**Raised by:** conversation on 2026-09-06

**What was decided.** One set of `task.*` tools, two backends. Linear owns
tasks whenever a Linear account is connected; the Convex `tasks` table owns
them when one is not. The choice is made in code from a database fact, never
by the model.

**Why not delete the Convex tables.** The project is likely to be open
sourced. A user without Linear must still get a working assistant — so the
local table is the fallback, not dead weight.

**The convention.** A project is a **Linear label**. `task.create` adds the
project name as a label automatically; extra tags go in `labels`.

**Links.** `CHANGELOG.md` 2026-09-06, `MEMORY.md` "Runtime-dependent
consequentiality"

---

## 2026-09-06 · N-006 · [NOTE] `docs/ROADMAP.md` is superseded

**Status:** NOTE
**Area:** docs
**Raised by:** doc audit, 2026-09-06

`ROADMAP.md` was last verified 21 Aug 2026 and declares eleven phases
"not built — documentation only". **Nine of those have since shipped.** It
also says "22 tools" where there are now 46.

A stale roadmap is worse than no roadmap: it is the file someone reads to
decide what to build next. `docs/STATUS.md` replaces it and is the one to
trust; ROADMAP now says so at the top.

**Links.** `docs/STATUS.md`

---

## 2026-09-06 · N-006b · [BLOCKED] Calendar, Drive and mailbox actions are inert until you reconnect

**Status:** BLOCKED — waiting on a Google Cloud Console change and one
reconnect per mailbox. Both are yours, not mine.
**Area:** connectors · oauth
**Raised by:** verifying Phases 10 and 11 against the live deployment

**The problem.** Google does not retroactively grant a scope to a token that
was issued without it. Every connected account predates Calendar, Drive and
`gmail.modify`, so all three capabilities exist in code, are tested, and
cannot do anything.

`bunx convex run debug:accounts '{}'` shows the truth: a `can` list per
account, currently empty for all three mailboxes.

**What fixes it.**

1. In Google Cloud Console, add to the consent screen:
   `calendar.readonly`, `calendar.events`, `drive.readonly`, `gmail.modify`.
2. `/reconnect <address>` once per mailbox in Telegram.
3. Re-run `debug:accounts` and check `can` now lists calendar, drive and
   mailboxActions.

**Why this is not a design flaw.** Requesting every scope up front, before
any feature used them, would have meant a consent screen asking for calendar
and drive access on day one for no reason. Least privilege has a migration
cost and this is it — paid once, on a reconnect that happens weekly anyway.

**Links.** [[N-003]], `docs/STATUS.md`

---

## 2026-09-06 · N-007 · [PLAN] Attaching a Drive file to an outgoing email

**Status:** PLAN
**Area:** connectors · email
**Raised by:** Phase 11, which stopped one step short of its own exit criterion

**The idea.** *"Draft a reply to Sarah with my CV attached"* — Drive already
finds the CV, and the draft/approve/send flow already works. What is missing
is the join between them.

**Why it is not done yet.** Two real pieces of work, neither of which should
be rushed:

1. `gmail.sendReply` builds a simple RFC 5322 message. An attachment needs
   `multipart/mixed` with base64 parts, and getting MIME subtly wrong
   produces mail that renders as gibberish in some clients and fine in
   others.
2. The file id must go into the approval hash. `DraftPayload.attachmentFileIds`
   already exists and is already hashed — it has been there since Phase 6
   precisely so this had no special case to remember. So this half is a
   wiring job, not a design one.

**The rule that must not be lost.** The model NARROWS, the user CHOOSES.
Never let it pick the attachment. Attaching the wrong CV — or a document
with a client's data — to a recruiter is the failure that would end trust in
the whole system. Swapping an attachment must void the approval, which is
exactly what hashing the file ids buys.

**Next step.** Multipart MIME builder as a pure module in `lib/email/`, with
tests, before touching the send path.

**Links.** [[N-003]], Phase 11 exit criterion

---

## 2026-09-06 · N-008 · [PLAN] Unsubscribe, safely or not at all

**Status:** PLAN
**Area:** email
**Raised by:** Phase 8, where it was deliberately left out

**The idea.** An `email.unsubscribe` tool for the promotional mail that
survives the noise filters.

**Why it was left out of Phase 8.** The blueprint is explicit: *never click
arbitrary unsubscribe URLs without validation.* An unsubscribe link is a URL
supplied by the sender — i.e. by an untrusted party — and fetching one is
both an external action and a confirmation that the address is live. Doing
this badly is worse than not doing it.

**How to do it properly, when it is done.**

- **One-click only.** Act solely on `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  (RFC 8058) — a POST to an `https` URL the sender declared in a header we
  already store and already parse (`listUnsubscribe`, `listUnsubscribePost`
  are both in the schema).
- **Never a `mailto:` and never a bare link.** If there is no one-click
  header, show the user the link and let them decide. That is not a
  limitation, it is the correct answer.
- **Consequential**, with an approval bound to the message and the URL.
- Run every URL through `lib/net/urlGuard.ts`, which already exists for the
  social-link reader and does exactly this job.

**Next step.** None scheduled. Pick it up when promotional mail is actually
annoying enough to justify it.

**Links.** [[N-004]], `convex/lib/net/urlGuard.ts`

---

## 2026-09-07 · N-009 · [DROPPED] WhatsApp — the workflow asked for is not possible

**Status:** DROPPED. Revisit only if Meta ships a personal-account read API.
**Area:** connectors · channels
**Raised by:** channel scope document, 2026-09-07

**What was asked for.** Monitor the **existing/main** WhatsApp account, watch
messages from designated people (clients, employers, people I am meeting),
detect actionable requests — *"please send the documents tomorrow"* — and
surface them through Telegram with an offer to create a task. Explicitly
conditional: build it only if that is genuinely possible through a reliable
and supported approach.

**The finding: it is not.** Researched 2026-09-07.

- **Meta's official Cloud API cannot do it.** It is a send pipe with an
  inbound webhook attached — business-only, delivering messages sent *to* a
  registered business number, once, as they arrive. There is no GET endpoint
  that returns a conversation, and a personal account is not addressable by
  it at all. ([Meta Cloud API docs](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/),
  [Unipile's 2026 API guide](https://www.unipile.com/whatsapp-api-a-complete-guide-to-integration/))
- **Every product that CAN do it uses a QR-code session** — Unipile,
  Blueticks, Whapi, and the open libraries Baileys, WAHA and Evolution API.
  All pair as a linked device over a reverse-engineered protocol.
  ([Blueticks](https://blueticks.co/blog/whatsapp-api-read-messages-and-chats),
  [Whapi](https://whapi.cloud/docs))
- **That route is a ToS violation with a severe, well-documented outcome.**
  Meta flags QR-paired unofficial clients at the network layer; the reported
  result is an immediate and permanent ban with no effective appeal, and
  unofficial tooling typically survives 2–8 weeks before detection. Meta
  stepped up enforcement through 2025.
  ([Whapi on avoiding bans](https://whapi.cloud/blog/how-to-avoid-whatsapp-ban-2026),
  [Achiya, 50+ cases](https://achiya-automation.com/en/blog/whatsapp-spam-detection-2026/),
  [WASenderApi](https://wasenderapi.com/blog/how-to-use-evolution-api-without-getting-banned-on-whatsapp-2026-guide))

**A second, independent blocker.** A QR session is a long-lived WebSocket
holding a device registration. Convex is serverless V8 with no persistent
processes, and invariant 7 targets $0/month. Even accepting the ban risk,
there is nowhere on this stack for it to run — it would need a separate
always-on host, which is a new bill and a new thing to operate.

**The trade, stated plainly.** The account at risk is the primary personal
one — the same account carrying the client and employer conversations the
feature exists to watch. Losing it permanently, to gain a notification, is a
bad trade at any probability.

**What to do instead.** Nothing, for now. The cheapest approximation is that
important people usually also email, and email monitoring is complete.

**Next step.** None. Recorded so it is not re-litigated.

**Links.** [[N-004]], `docs/STATUS.md`

---

## 2026-09-07 · N-010 · [DROPPED] The Mac companion is removed from the plan

**Status:** DROPPED
**Area:** architecture · roadmap
**Raised by:** channel scope document, 2026-09-07

**The decision.** Build plan Phase 20 — a macOS companion app exposing
iMessage and other local-only capabilities to the cloud agent — is out. Not
MVP, not future work, unless explicitly reconsidered later.

**Cost of removal: none.** Nothing was ever built for it. No schema, no
connector, no tool, no env var. This is a documentation change, which is the
cheapest possible moment to drop something.

**What it takes with it.** iMessage and SMS access. There is no other route
to those from a cloud service, so they are out too rather than pending.

**Worth keeping from it.** The original reasoning was sound and generalises:
*do not give a cloud service unrestricted access to a Mac or its Messages
database.* If a local companion is ever reconsidered, that constraint comes
back with it — narrow, authenticated capabilities, never a general channel.

**Links.** [[N-009]], `docs/STATUS.md`

---

## 2026-09-07 · N-011 · [DONE] Social posts: every slide, then one tap to save the lot

**Status:** DONE (2026-09-07)
**Area:** social · capture
**Raised by:** channel scope document, 2026-09-07

**What shipped.**

- **Every slide is read, not four.** The OCR cap was silently 4; a ten-slide
  deck came back with six missing and nothing saying so. It is now 20 — the
  Instagram carousel maximum — the slides are numbered `--- Slide N ---` so
  they stay distinguishable, the token budget scales with slide count, and
  anything beyond the cap is reported rather than dropped.
- **`capture.propose` / `capture.apply`.** "Add these movies" now produces a
  numbered card listing every item found, with one **Add all N** tap. The
  list is stored and hashed, so nothing has to be re-derived from the
  transcript between the finding and the tap — which is where items get
  silently lost.
- Duplicates are collapsed **and reported**; overflow past 30 is reported.

**The Instagram limit is real and is not a gap here.** A third party cannot
read the individual carousel images of someone else's post from a URL. oEmbed
returns embed HTML with a thumbnail and no media URLs; Business Discovery
needs the target to be a Professional account, needs a username rather than a
link, and needs your own Professional account plus App Review.
([Instagram official API reference, April 2026](https://gist.github.com/jameschapman2c/65eff9f54a2d350b17a6ce5127b9fe42))

So for Instagram and Facebook the link path gets the caption and the cover
slide, says so plainly, and asks for the slides as a Telegram album — which
is read **in full**, and always was. X gives full text; TikTok gives caption
and cover.

**Next step.** None required. If full carousels from a link ever become worth
paying for, the seam is `fetchPost` in `connectors/social/client.ts`.

**Links.** [[N-004]], `docs/FLOWCHART.md`
