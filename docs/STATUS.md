# Status — where the project actually is

**Verified against the codebase on 2026-09-07.** This file replaces
`docs/ROADMAP.md`, which was last checked on 21 Aug 2026 and is now wrong in
both directions.

Measured against three documents: the original
[blueprint](personal_ai_assistant_blueprint.md), the authoritative
[build plan v3](personal-ai-assistant-build-plan-v3-convex.md), and the phase
guides in [`docs/build/`](build/).

---

## The one-line answer

**The MVP is done, and so is Stage C.** Of the twenty-three phases in the
build plan, **seventeen have shipped**. Phase 8 closed the last Stage B gap,
and Phases 10 and 11 closed Stage C — which means the blueprint's own
Definition of Done is now met in full.

What remains is Stage D (the proactive half — evening brief, daily focus,
check-ins) and a long tail of breadth nobody currently needs.

```text
STAGE A  Prove the loop            ███████████████  3/3   done
STAGE B  Email intelligence        ███████████████  6/6   done  ← the MVP line
STAGE C  Modalities & context      ███████████████  3/3   done
STAGE D  Proactive secretary       ███░░░░░░░░░░░░  ~1/3  brief only, partially
STAGE E  Breadth & depth           ███░░░░░░░░░░░░  1/4   Linear only
STAGE F  Frontier                  ███░░░░░░░░░░░░  1/4   meetings only
```

**One thing gates all of it in practice:** every Google account is currently
`NEEDS_REAUTH`, and Calendar, Drive and mailbox actions were added *after*
they were last connected. Google never adds a scope to an existing token, so
those capabilities are inert until each mailbox is reconnected once. Check
with `bunx convex run debug:accounts '{}'` — the `can` list per account is
the readout that matters.

### By the numbers

| | |
|---|---|
| Tools the assistant can call | **60** |
| Of those, needing your approval | **4** — send email, apply a Linear batch, send a calendar invite, save a found batch |
| Slash commands | **15** |
| Scheduled jobs | **5** |
| Connectors live | **6** — Gmail, Calendar, Drive, Notion, Linear, social links |
| AI providers wired | **4** — Gemini, OpenAI, Anthropic, OpenRouter |
| Pure-logic modules | 39 files under `convex/lib/` |
| Unit tests | **732**, across 38 files, no Convex runtime needed |
| Infrastructure cost | **$0/month** — invariant 7 still holds |

---

## Phase by phase

Legend: ✅ shipped · 🟡 partial · ⬜ not started · ⛔ deliberately not doing

### Stage A — Prove the loop

| Phase | | Evidence |
|---|---|---|
| 0 — Foundation, secrets, skeleton | ✅ | `d457315` |
| 1 — Telegram ↔ core ↔ AI ↔ Convex | ✅ | `04c1b09` |
| 2 — Memory, tasks, reminders, scheduler | ✅ | `04c1b09` |
| 2B — User context *(added, not in plan)* | ✅ | `941da9d` |

### Stage B — Email intelligence · **the MVP**

| Phase | | Evidence |
|---|---|---|
| 3 — One Gmail, read-only, including spam | ✅ | `04c1b09` |
| 4 — Importance classification | ✅ | `0f73abb` |
| 5 — Alerts, summaries, full content | ✅ | `16830fe` |
| 5B — Chat-configurable morning brief *(added)* | ✅ | `50b3874` |
| 6 — Draft, approve, send | ✅ | `7131c5f` |
| 7 — Three mailboxes, deterministic routing | ✅ | `9b62768` |
| 8 — Push, reconciliation, email actions | ✅ | **the MVP line, now crossed** |

**What Phase 8 shipped:**

1. **Push via Pub/Sub.** `POST /webhooks/gmail` verifies Google's OIDC token
   against Google's own public keys — issuer, audience, service account,
   expiry, then RS256 signature — before it will act on anything. The
   endpoint is public, so that token is the only thing protecting it.
   Notifications drive an incremental `history.list` sync, and a `users.watch`
   is renewed daily by cron because a lapsed watch fails *silently*.
   Polling stays in place as the reconciliation safety net, exactly as the
   plan requires.
2. **Email actions.** `email.archive`, `email.mark_read`, `email.mark_unread`
   and `email.label`. All four are label edits under the hood, all four are
   reversible, and none needs approval.

**Deliberately not in Phase 8: unsubscribe.** The blueprint says never to
click an arbitrary unsubscribe URL, and doing it safely means one-click
RFC 8058 POSTs only, behind an approval. Worth doing; not worth doing badly.
See [NOTES.md N-008](NOTES.md).

### Stage C — Modalities and context

| Phase | | Notes |
|---|---|---|
| 9 — Voice notes | ✅ | Pulled forward, ahead of plan |
| 10 — Google Calendar | ✅ | Read, free-slot search, and create. **Consequentiality is about attendees:** a solo block just happens, anything with a guest waits for your tap |
| 11 — Google Drive as context | ✅ | Read-only search and text extraction. The model narrows, you choose. Attaching a file to an outgoing email is **not** included — see [NOTES.md N-007](NOTES.md) |

### Stage D — The proactive secretary

| Phase | | Notes |
|---|---|---|
| 12 — The unified morning brief | 🟡 | Morning brief ships and is chat-configurable. **Missing:** the evening brief, today's calendar in the brief (Phase 10 now unblocks this — it just is not wired in yet), and the weekly cost line the plan explicitly asks for |
| 13 — Daily focus + blocker state machine | ⬜ | `dailyFocus` table exists in the schema and **nothing reads or writes it** |
| 14 — Check-ins and adaptive scheduling | ⬜ | The `blockers.by_expected` index exists purely for this and is unused |

### Stage E — Breadth and depth

| Phase | | Notes |
|---|---|---|
| 15 — Zoho and Outlook | ⬜ | Build doc written. No current user — see below |
| 16 — Linear | ✅ | `c02ee7a`, and extended on 2026-09-06 to own tasks outright |
| 17 — Memory 2.0 (vectors) | ⬜ | Has a **measured trigger**: >20% of context queries failing, or >500 notes. Not reached. `memories` table exists, unused. Notion fills the role today |
| 18 — Graduated autonomy | ⛔ | Deliberately not started. `AUTONOMOUS_SEND_ENABLED` **must not exist** before this phase |

### Stage F — Frontier

| Phase | | Notes |
|---|---|---|
| 19 — WhatsApp | ⛔ | **Not doing.** Researched 2026-09-07 and the answer is no — see below and [NOTES.md N-009](NOTES.md) |
| 20 — Mac companion (iMessage) | ⛔ | **Removed from the plan** on 2026-09-07, by decision. Not MVP, not future, unless explicitly reconsidered |
| 21 — Meeting intelligence | ✅ | `7394569` |
| 22 — Meeting representative, phone calls | ⬜ | — |

### Shipped but never planned

Roughly a third of what exists was not in any phase document — added on
request as the system met real use:

Notion notes and long-tail memory · reading social posts from a pasted link ·
images, carousels, PDFs and `.md`/`.txt` files · **skills** (editable
procedures) · **custom instructions** · windowed live email search ·
the scope guard against fabricated capability claims · the pluggable task
backend.

---

## Against the original blueprint's Definition of Done

The blueprint's §28 lists eleven things. **All eleven are true today.**

| | Blueprint requirement |
|---|---|
| ✅ | Connect all three Gmail accounts |
| ✅ | An important email from any account triggers a Telegram alert |
| ✅ | Spam and other configured folders are in the scan strategy |
| ✅ | The alert identifies the source mailbox |
| ✅ | You can request a summary |
| ✅ | You can request a draft |
| ✅ | The assistant can find approved context/documents — Drive, as of Phase 11 |
| ✅ | It shows the draft |
| ✅ | "Send it" sends from the correct account, only after explicit approval |
| ✅ | All actions are logged |
| ✅ | A scheduled digest works |

The blueprint also assumed a stack that no longer applies — Postgres via
Supabase, Prisma, Fastify, Railway. The project runs on **Convex**, which
collapsed the database, scheduler, file storage and HTTP layer into one thing
and is why infrastructure still costs nothing. Read §6 and §26 of the
blueprint as history, not instruction.

---

## The seven invariants — all holding

| | Invariant | Where it is enforced |
|---|---|---|
| ✅ | The model proposes; the application disposes | `lib/tools/plan.ts` → `tools/router.ts` |
| ✅ | External content is data, never instruction | `AIRequest.untrusted`; output schemas have no action field |
| ✅ | Account identity resolved in code, never inferred | `router.ts` — a reply's account comes from the source message |
| ✅ | Consequential actions need a typed, expiring, single-use approval | `model/approvals.ts` — 7 checks, hash recomputed from the live draft |
| ✅ | `auditLogs` is append-only | No delete function exists |
| ✅ | Channels, providers and connectors are replaceable | 4 providers behind one interface; 4 connectors; 1 channel file |
| ✅ | Cost is a design constraint | $0/month. Deterministic pre-filter before every classifier call |

---

## Known gaps that are not phases

Real, small, and worth fixing before the next big build.

1. **Three slash commands have no plain-English equivalent.** `/sync`,
   `/reconnect` and `/status` can only be typed. `/reconnect` is the one you
   use weekly. See [FLOWCHART.md §3](FLOWCHART.md#3-slash-command-vs-plain-english).
2. **The morning brief has no calendar and no cost line.** The plan asks for
   both. Calendar is no longer blocked — Phase 10 shipped, it just is not
   wired into `briefs.ts` yet.
3. **No evening brief.** The plan argues it is what makes the morning brief
   accurate, because it is where you correct the assistant's model of the day.
4. **`connectedAccounts.priorityRules` has no writer.** Per-account importance
   floors can only be set by hand-editing a row in the Convex dashboard.
5. **`dailyFocus` and `memories` are declared but unused.** Both are fine —
   they are Phases 13 and 17 — but a schema table nothing reads is worth
   remembering is empty.
6. **Reminders cannot attach to a task.** `reminders.taskId` and `projectId`
   exist and nothing populates them, so "remind me about this task" is wiring
   that is already half-built.
7. **A Drive file cannot be attached to an outgoing email.** Drive can find
   and read a document; sending one needs MIME multipart in `gmail.sendReply`
   and the file id in the approval hash. `DraftPayload.attachmentFileIds`
   already exists for exactly this. See [NOTES.md N-007](NOTES.md).
8. **No unsubscribe tool.** Deliberate — see [NOTES.md N-008](NOTES.md).

---

## What to build next, in order

| | What | Why now | Blocked on |
|---|---|---|---|
| **0** | **Reconnect each Google account** | Calendar, Drive and mailbox actions are shipped but inert until each token carries the new scopes | **You:** add `calendar.readonly`, `calendar.events`, `drive.readonly` and `gmail.modify` to the consent screen, then `/reconnect <address>` per mailbox |
| **1** | Turn on Gmail push | The topic and audience are already configured on dev. Needs a push subscription to `/webhooks/gmail`, then `bunx convex run gmail:watchAll '{}'` | **You:** the Pub/Sub subscription |
| **2** | Calendar into the morning brief | The brief is a morning brief with no schedule in it. Now unblocked | nothing |
| **3** | Phase 12 finish — evening brief, cost line | The cost line is what stops a surprise bill | nothing |
| **4** | Phase 13 — daily focus | `dailyFocus` is already in the schema | nothing |
| **5** | Drive attachments on outgoing mail | Completes the blueprint's north-star example end to end | nothing |
| — | Zoho / Outlook (15) | **Do not build a mailbox nobody reads.** Only if a real account appears | — |
| ⛔ | WhatsApp (19), Mac companion (20) | **Both removed from the plan.** See the decision below | — |

**The theme has changed.** Nothing substantial is waiting on code any more —
items 2 through 5 are all unblocked. What is blocking the *shipped* work is
one round of reconnecting, which is yours to do and takes a minute per
mailbox.

---

## Two channels that are now closed

### The Mac companion is removed

Phase 20 — a macOS companion app to reach iMessage and other local-only
services — is **out of the plan**, by decision on 2026-09-07. Not MVP, not
future work, unless it is explicitly reconsidered. Nothing was ever built for
it, so removal is a documentation change only.

### WhatsApp: researched, and the answer is no

The requirement was specific: monitor the **existing personal** WhatsApp
account, spot messages from designated people, detect actionable requests,
and surface them through Telegram. The rule attached was equally specific —
build it only if that workflow is genuinely possible through a reliable,
supported approach.

It is not. Researched 2026-09-07:

| Route | Can it read your personal chats? |
|---|---|
| Meta's official **Cloud API** | **No.** Business-only, and a send pipe with an inbound webhook — messages sent *to* a registered business number, delivered once, at the moment they arrive. There is no endpoint that returns a conversation, and your personal account is not in it at all. |
| **QR-session bridges** (Unipile, Blueticks, Whapi, Baileys, WAHA, Evolution API) | Technically yes — and this is the only route that can. |

Every product that reads a personal WhatsApp account does it by pairing as a
linked device over a **reverse-engineered** protocol. That is a Terms of
Service violation, Meta detects it at the network layer, and the reported
outcome is an **immediate and permanent ban with no effective appeal** —
typically within 2–8 weeks. Sources are in [NOTES.md N-009](NOTES.md).

There is a second, independent blocker: a QR session is a long-lived
WebSocket holding a device registration. This project runs on Convex's
serverless V8 runtime with no persistent processes, and targets $0/month
(invariant 7). Even with the ban risk accepted, it has nowhere to live.

**Decision: not implemented.** Risking the permanent loss of a primary
personal WhatsApp account — the one carrying the client and employer
conversations the feature exists to watch — is a bad trade for a
notification. This is recorded so it is not re-litigated; it changes only if
Meta ships a personal-account read API.

## Where to read next

| File | For |
|---|---|
| [FLOWCHART.md](FLOWCHART.md) | How a message actually flows, with file names |
| [NOTES.md](NOTES.md) | What we are thinking of doing, and where each idea stands |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Why it is shaped this way |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Where the code is, in prose |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed |
| [`MEMORY.md`](../MEMORY.md) | What bit us, and why |
