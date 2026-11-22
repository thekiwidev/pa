# Phase 23 — Email: owner-defined importance, unread-aware alerts

Source plan: `~/.claude/plans/pasted-content-id-d370-all-right-curried-fern.md`, Phase 23. Status: built; the dev-mailbox exit test has not been run.

## What it does

1. The owner says in plain words what matters ("alert me: invoices from clients", "never alert: login notices"). Those sentences reach the classifier whole and outrank its default rubric.
2. Important mail pages the phone only while it is unread. HIGH waits a grace period (default 15 min); CRITICAL still pages at once. One reminder follows 48 h later if the mail is still unread. A mail read at any point ends the chain.

## How it works

- **Criteria.** New `userContext` category `email_importance` (`lib/userContext.ts`); entries start with `alert me:` or `never alert:`. `lib/email/importance.ts#splitOwnerContext` separates them from the owner facts (still capped at 15). `buildClassificationInput({ownerCriteria})` renders every criterion under "Owner's alert rules" in the trusted `input`; the email body and links stay in `untrusted`. Chat: the planner maps "this kind of email matters / does not matter" to `context.set {category:"email_importance"}` (catalog text and prompt rule 7). List and remove are the existing `context.list` / `context.remove`.
- **Rubric v4** (`CLASSIFIER_VERSION = "v4"`): routine security and sign-in notices, OTPs, receipts and shipping updates are NORMAL (digest). CRITICAL security is reserved for signs that someone else is in the account (password or recovery change, unknown app, suspicious debit). Only mail classified after deploy uses v4; stored rows are not re-classified.
- **"Not important" button.** Still adds the sender to `noiseSenders`; if the classifier category is narrow (`SECURITY_ALERT`, `PROMOTION`, `NEWSLETTER`) it then offers "Never alert for <kind> at all?" (callback `nevercat:<id>`). Tapping saves `never alert: <kind>` as a criterion. The sentence comes from a fixed category table in `categoryCriterion`, never from the email text.
- **Unread chain** (`gmail.ts`): `deliverIfDue` skips mail that arrives already read. CRITICAL calls `runAlertStep` directly. HIGH schedules `alertIfUnread` after `notify.emailGraceMinutes`. `runAlertStep` re-checks unread (local label first, then Gmail `format=minimal`; fails open if Gmail cannot be asked, 404 counts as read), asks the policy (`email_important` / `email_unread_followup`), then: `defer` re-schedules at the end of quiet hours, `send` calls `notify.sendAlert` and arms `alertIfUnread {followup:true}` at +48 h. The follow-up claims `notifications.followupSentAt` (check-then-set in `claimFollowup`) before sending, so a thread gets at most one reminder, and shows "Important and unread for 48h" above the card.
- **Quiet hours** now come from the `notify` pref (`quietHours`, default 22:00-07:00), replacing the hard-coded 07:00-22:00 window.

## Decisions

- Already-read mail never alerts, CRITICAL included (the plan said CRITICAL "as today"; an alert for a mail the owner has already read adds nothing).
- Follow-up is claimed per thread (the `notifications` row is per thread), which is stricter than per message.
- A rate-limited alert has no `notifications` row, so it gets no 48 h reminder.

## Files

`convex/lib/email/{importance,unread,classification}.ts`, `convex/lib/{userContext,prompts/assistant,tools/catalog}.ts`, `convex/{gmail,notify,assistant}.ts`, `convex/connectors/gmail/client.ts` (`getMessageLabels`), `convex/model/notifications.ts` (`claimFollowup`), `convex/schema.ts` (`notifications.followupSentAt`), tests `email-importance`, `email-unread`, `email-classification`.

## Exit criterion and status

Dev mailbox: an important mail read within 15 min gives no alert; one left unread gives one alert at 15 min and one at 48 h, never a third; a login notice gives no alert; "alert me: X" changes the next X mail's classification. **Not run** (needs a live mailbox and 48 h).
