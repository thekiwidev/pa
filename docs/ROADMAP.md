# Execution roadmap

**What this is.** The order to build the remaining phases in, what each one needs from you before it can start, and how you know it worked.

**What this is not.** An implementation plan — those already exist. Every phase below has a complete build document in `docs/build/` with file manifests, full code, and per-step verification. This file answers *"in what order, and what's blocking?"*, nothing else.

Last verified against the codebase: **21 Aug 2026**.

---

## Where things actually stand

**Built and live on dev** (`coordinated-owl-164`):

| Phase | Capability |
|---|---|
| 0 | Convex scaffold, schema, `/health` |
| 1 | Telegram webhook, AI provider registry, message persistence |
| 2 | Projects, tasks, blockers, reminders, people, tool router, exact-time scheduling |
| 3 | Gmail OAuth, encrypted credentials, spam-inclusive sync, email read tools |
| 9 (early) | Voice notes — pulled forward while fixing an unrelated bug |

Plus four capabilities not in the original plan, added on request: **skills**, **custom instructions**, **deep search** (past the 2-day sync cache), and the **scope guard** against fabricated capability claims.

Current surface: 22 tools · 13 commands · 3 crons · 1 mailbox connected.

**Not built — documentation only.** Phases 2B, 4, 5, 5B, 6, 7, 8, 11, 15, 16, 21. Zero lines of their code exist. Every file listed in those docs is absent from the repo.

> **The distinction that matters:** writing a build doc changes nothing about what the bot can do. `docs/build/` describes intended end-states. Several docs were written in one sitting and each describes the world *as of its own completion* — so a later doc may reference a file an earlier doc creates, which still does not exist. Trust the repo, not the docs' claims about each other. Each doc carries its own notes where it found this.

---

## Dependency graph

```text
2B user context ─────┬──────────────────────► 21 meeting transcripts
                     │
                     └──► 4 classification ──► 5 alerts ──► 5B morning brief
                                                   │
                                                   └──► 6 send ──► 7 mailboxes ──► 8 push

independent, any time:  11 Drive     16 Linear     15 Zoho
```

Only three edges are hard:

- **4 → 5** — an alert has nothing to fire on without an importance class.
- **5 → 5B** — the brief surfaces what alerts suppressed; it needs the delivery rules to exist.
- **2B → 21** — *"a TL;DR for me"* is undefined until the system knows who "me" is.

**6 → 7 → 8** is a risk ordering, not a technical one. Sending from one mailbox must be proven before three mailboxes multiply the blast radius, and push shouldn't land on an unproven send path.

---

## Build order

### 1 · Phase 2B — User context
**Needs from you:** nothing.
**Doc:** [`PHASE-02B-user-context.md`](build/PHASE-02B-user-context.md)

Small — one table, three tools, prompt wiring. First because it's cheap and it improves Phase 4 immediately: knowing your role and what you work on is most of what separates important mail from noise, and the classifier currently has none of it.

**Gate:** tell it *"I'm a frontend engineer"* → recorded as a fact, no task created. Tell it *"keep replies short"* → recorded as an instruction instead. The fact/rule distinction holding is the whole test.

---

### 2 · Phase 4 — Importance classification
**Needs from you:** nothing.
**Doc:** [`PHASE-04-importance-classification.md`](build/PHASE-04-importance-classification.md)

The unlock. Every synced email gets CRITICAL/HIGH/NORMAL/LOW/IGNORE plus a rationale. First phase where a model reads email content, so it's the first real exercise of invariant I-2 — untrusted framing plus an output schema with no field that can express an action.

**Gate:** a spam message that fails DMARC and asks for credentials classifies `IGNORE`/`PHISHING_SUSPECTED` regardless of how urgent its subject sounds. The pre-filter demonstrably skips the model entirely for promotional mail.

---

### 3 · Phase 5 — Alerts, summaries, cards
**Needs from you:** nothing.
**Doc:** [`PHASE-05-alerts-and-summaries.md`](build/PHASE-05-alerts-and-summaries.md)

Biggest structural addition of the three: Telegram **inline keyboards** mean handling `callback_query` updates, which `http.ts` doesn't parse today. That's new webhook surface, not a formatting change. Also the first use of `parse_mode`, which makes MarkdownV2 escaping mandatory from day one.

**Gate:** mark a plausible recruiter email as spam → a badged card arrives within one sync cycle, naming the mailbox, and all three buttons work.

---

### 4 · Phase 5B — Morning brief
**Needs from you:** nothing.
**Doc:** [`PHASE-05B-morning-brief.md`](build/PHASE-05B-morning-brief.md)

Self-rescheduling via `ctx.scheduler.runAt` rather than a fixed cron — that's what makes the time chat-editable without a redeploy. Covers midnight-yesterday through send time, and excludes anything already pushed as a real-time alert.

**Gate:** *"send me a brief at 7am"* configures it by chat; changing the time reschedules; disabling stops it. No deploy in between.

---

### 5 · Phase 21 — Meeting transcripts
**Needs from you:** nothing (2B must be built).
**Doc:** [`PHASE-21-meeting-transcripts.md`](build/PHASE-21-meeting-transcripts.md)

Placed here because it's high value and has no external dependencies — not because 21 comes after 8. Nothing joins or records a call; you supply a transcript you already have.

**Gate:** a commitment with no owner named appears under NEEDS YOUR CALL and creates nothing. A transcript containing an injection attempt is extracted as data with no tool proposed.

---

### 6 · Phase 6 — Draft, approve, send ⚠️
**Needs from you:** **re-authorize Gmail once** — send scope isn't in your current grant, and OAuth grants don't widen retroactively.
**Doc:** [`PHASE-06-draft-approve-send.md`](build/PHASE-06-draft-approve-send.md)

**The highest-risk phase in the roadmap.** First time the assistant can send anything. Turns `tools/router.ts`'s consequential-tool refusal from an unconditional "no" into a real approval check — the single most consequential edit in the whole project.

Don't rush this one, and actually run its adversarial tests rather than assuming: expired approval refused, edited draft voids its approval, mismatched account throws, a recipient not in the thread is refused.

**Gate:** a real reply lands in a real inbox, in the correct thread, from the correct address — and all six refusal cases appear in `auditLogs`.

---

### 7 · Phase 7 — Three mailboxes
**Needs from you:** run `/connect <label>` twice more.
**Doc:** [`PHASE-07-three-mailboxes.md`](build/PHASE-07-three-mailboxes.md)

Mostly configuration plus a small sync-fairness change. Priority rules are applied as **code against classifier output**, never as prompt text — a prompt instruction is a suggestion, a rule engine is a guarantee.

**Gate:** a reply to the recruiting thread sends from the recruiting address, verified in the recipient's headers rather than your logs.

---

### 8 · Phase 8 — Push, reconciliation, email actions
**Needs from you:** **Google Cloud Pub/Sub setup** — create a topic, grant `gmail-api-push@system.gserviceaccount.com` the Publisher role, create a push subscription. Env vars are already provisioned.
**Doc:** [`PHASE-08-push-reconciliation-actions.md`](build/PHASE-08-push-reconciliation-actions.md)

Near-real-time delivery replaces polling, plus the safe subset of mailbox actions. **No hard-delete tool is ever added** — trash only, with a test asserting the registry contains no such name.

**Gate:** this is the source plan's own MVP Definition of Done — 11 items, reproduced verbatim in the doc.

> **The source plan's advice, worth honouring:** *"At this point stop and use it for two weeks before building Phase 9. You will discover that two things you planned are unnecessary and one thing you did not plan is essential."* Everything after this point is breadth. This is where it becomes the thing you actually wanted.

---

### Independent — any time after Phase 6

| Phase | Needs from you | Doc |
|---|---|---|
| **16 Linear** | nothing — `LINEAR_API_KEY` already set | [`PHASE-16-linear.md`](build/PHASE-16-linear.md) |
| **11 Drive** | add `drive.readonly` to the OAuth consent screen | [`PHASE-11-drive-context.md`](build/PHASE-11-drive-context.md) |
| **15 Zoho** | register the redirect URI in the Zoho console — `ZOHO_*` already set | [`PHASE-15-zoho.md`](build/PHASE-15-zoho.md) |

All three touch the approval gate (Linear's batch apply, Drive's attachment hashing), so Phase 6 first.

---

## Prerequisites, collected

Everything the roadmap needs from you, in one place. None of it blocks phases 2B → 21.

| Before | Do this |
|---|---|
| Phase 6 | Re-run `/connect personal` after the send scope ships, to re-grant |
| Phase 7 | `/connect recruiting`, `/connect client` |
| Phase 8 | Google Cloud: Pub/Sub topic, Publisher grant, push subscription |
| Phase 11 | Google Cloud: add `drive.readonly` to the consent screen |
| Phase 15 | Zoho console: register `https://<deployment>.convex.site/oauth/zoho/callback` |

Standing item, unrelated to any phase: **there is still no git remote.** Five commits exist locally and nothing else. A private GitHub repo is worth ten minutes.

---

## Deliberately not planned

- **Phase 10 — Calendar.** Not requested. Phase 21 surfaces scheduling items as text rather than creating events because of this; it's the one place that phase visibly stops short.
- **Phase 12–14, 17–20, 22.** Beyond current scope. Phase 17 (Memory 2.0) has its own stated trigger — build it when relational retrieval measurably fails, not out of enthusiasm for embeddings.
- **Outlook.** No Microsoft credentials, by choice. Phase 15 is Zoho-only; don't scaffold Graph until that changes.
- **Images.** No doc, genuinely new work, small — Gemini takes inline images the same way it already takes voice audio. Slots in anywhere.

---

## How to run a phase

Each build doc is self-contained and followable top to bottom. The loop that has worked so far:

```bash
bun test && bun run typecheck    # green before starting
# ...follow the doc's steps...
bunx convex dev --once           # deploy to dev
```

Then verify against the **live** deployment, not just tests — `bunx convex run debug:planOnly '{"execute":true,"text":"..."}'` exercises the real router, which unit tests on pure modules cannot. Two bugs this session lived exactly in that gap.

Commit per phase. The doc ends with the message to use.
