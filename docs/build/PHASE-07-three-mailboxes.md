# Phase 7 — Three mailboxes, deterministic routing

**Build documentation.** Follow it top to bottom. Every step names the exact file, says what that file is for, gives you the content, and tells you how to check it worked.

- **Architecture reference:** `docs/Personal AI Assistant — Build Plan v3 (Convex).md` → *Phase 7*
- **Prerequisite:** Phase 6 complete — draft, approve, and send work end to end on one mailbox, and the consequential-tool approval gate in `convex/tools/router.ts` is live.

---

## What you'll have at the end

Three Gmail mailboxes connected and syncing — personal, recruiting, client, or whatever labels you actually use. Each account carries its own floor/ceiling priority rules, applied as code between the Phase 4 classifier and the Phase 5 delivery decision, so "every interview email from the recruiting mailbox is at least CRITICAL" is a guarantee your prompt could never make stick. Sync no longer favors whichever mailbox happens to be first in the list — all ACTIVE accounts are synced concurrently, so a noisy personal inbox can't push a slow start onto the recruiting one you actually care about.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 1 | `convex/lib/email/priority.ts` | new | **Pure.** The floor/ceiling rule engine — no ctx, no I/O |
| 2 | `tests/unit/priority-rules.test.ts` | new | Every branch of the rule engine |
| 3 | *(operational — no file)* | — | Connect two more Gmail mailboxes via `/connect` |
| 4 | `convex/gmail.ts` | edit | Wire priority rules into the classify path; sync all ACTIVE accounts concurrently |
| 5 | `tests/unit/notify-card.test.ts` | edit | Lock in "a card always names its mailbox" as a structural guarantee |
| 6 | `convex/schema.ts` | audit only | Confirm `accountId` is required, not optional, wherever it must always be present |

---

## Step 1 — The floor/ceiling rule engine

**File:** `convex/lib/email/priority.ts` **(create)**

**What this file is for.** `connectedAccounts.priorityRules` (already in `schema.ts` as `v.optional(v.any())`, unused until now) holds a per-account JSON policy: floors that guarantee a minimum importance for a category, ceilings that cap a maximum. This runs **between** the Phase 4 classifier's output and the Phase 5 delivery-rule branch — it adjusts a rank the classifier already produced, it is never a second model call, and it is never text appended to a prompt. A prompt instruction is a suggestion a model can drift away from; a rule engine applied in code is a guarantee.

The shape matches the build plan's own examples exactly:

```jsonc
{
  "label": "recruiting",
  "floors": [
    { "when": { "category": "INTERVIEW" },       "minImportance": "CRITICAL" },
    { "when": { "category": "JOB_OPPORTUNITY" }, "minImportance": "HIGH" }
  ],
  "ceilings": [
    { "when": { "category": "PROMOTION" }, "maxImportance": "LOW" }
  ],
  "scanSpam": true
}
```

```ts
// Pure. No ctx, no fetch. Deterministic floor/ceiling adjustment applied to
// the Phase 4 classifier's output, keyed on connectedAccounts.priorityRules.
//
// This runs BETWEEN the classifier and the Phase 5 delivery-rule branch. It
// is code applied to a model's output, never a prompt instruction — a prompt
// instruction is a suggestion; this is a guarantee. "Every interview email
// from the recruiting mailbox is at least CRITICAL" is a promise a rule
// engine can keep and a system prompt cannot.

export type Importance = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "IGNORE";

const RANK: Record<Importance, number> = {
  IGNORE: 0,
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const IMPORTANCE_BY_RANK: readonly Importance[] = [
  "IGNORE",
  "LOW",
  "NORMAL",
  "HIGH",
  "CRITICAL",
];

/**
 * Matches the JSON shape stored on `connectedAccounts.priorityRules`
 * (`v.any()` in schema.ts — this is the type it actually holds).
 */
export interface PriorityRuleCondition {
  /** The classifier's `category` field, e.g. "INTERVIEW", "PROMOTION". */
  category?: string;
}

export interface PriorityRule {
  when: PriorityRuleCondition;
  minImportance?: Importance;
  maxImportance?: Importance;
}

export interface PriorityRules {
  label: string;
  floors?: PriorityRule[];
  ceilings?: PriorityRule[];
  /** Whether to apply these rules to messages already in SPAM. Read by the
   *  caller in convex/gmail.ts — this module only applies the floor/ceiling
   *  math, it does not know what folder a message is in. */
  scanSpam?: boolean;
}

function matches(when: PriorityRuleCondition, category: string | undefined): boolean {
  if (!when.category) return true;
  return when.category === category;
}

/**
 * Floors raise a rank, ceilings lower one — applied in that order, so a
 * ceiling always has the final word for a category that somehow matches
 * both a floor and a ceiling. The build plan's own example rule sets never
 * do this, but the order is a deliberate choice, not an accident of
 * iteration, and it's what the tests below pin down.
 *
 * A floor never LOWERS a rank the classifier already gave, and a ceiling
 * never RAISES one — each only pulls in its own direction.
 */
export function applyPriorityRules(
  importance: Importance,
  category: string | undefined,
  rules: PriorityRules | undefined,
): Importance {
  if (!rules) return importance;

  let rank = RANK[importance];

  for (const floor of rules.floors ?? []) {
    if (floor.minImportance && matches(floor.when, category)) {
      rank = Math.max(rank, RANK[floor.minImportance]);
    }
  }
  for (const ceiling of rules.ceilings ?? []) {
    if (ceiling.maxImportance && matches(ceiling.when, category)) {
      rank = Math.min(rank, RANK[ceiling.maxImportance]);
    }
  }

  return IMPORTANCE_BY_RANK[rank]!;
}
```

**Verify:** `bun run typecheck` — clean. Nothing calls this yet.

---

## Step 2 — Test the rule engine

**File:** `tests/unit/priority-rules.test.ts` **(create)**

```ts
import { describe, expect, test } from "bun:test";
import { applyPriorityRules, type PriorityRules } from "../../convex/lib/email/priority";

const recruiting: PriorityRules = {
  label: "recruiting",
  floors: [
    { when: { category: "INTERVIEW" }, minImportance: "CRITICAL" },
    { when: { category: "JOB_OPPORTUNITY" }, minImportance: "HIGH" },
  ],
  ceilings: [{ when: { category: "PROMOTION" }, maxImportance: "LOW" }],
  scanSpam: true,
};

const personal: PriorityRules = {
  label: "personal",
  ceilings: [
    { when: { category: "PROMOTION" }, maxImportance: "IGNORE" },
    { when: { category: "NEWSLETTER" }, maxImportance: "LOW" },
  ],
  scanSpam: true,
};

describe("applyPriorityRules", () => {
  test("a floor raises a classifier's rank", () => {
    expect(applyPriorityRules("LOW", "INTERVIEW", recruiting)).toBe("CRITICAL");
    expect(applyPriorityRules("NORMAL", "JOB_OPPORTUNITY", recruiting)).toBe("HIGH");
  });

  test("a floor never LOWERS a rank the classifier already gave", () => {
    expect(applyPriorityRules("CRITICAL", "JOB_OPPORTUNITY", recruiting)).toBe("CRITICAL");
  });

  test("a ceiling caps a classifier's rank", () => {
    expect(applyPriorityRules("HIGH", "PROMOTION", recruiting)).toBe("LOW");
    expect(applyPriorityRules("CRITICAL", "PROMOTION", personal)).toBe("IGNORE");
  });

  test("a ceiling never RAISES a rank the classifier already gave", () => {
    expect(applyPriorityRules("IGNORE", "PROMOTION", personal)).toBe("IGNORE");
  });

  test("an unmatched category passes through unchanged", () => {
    expect(applyPriorityRules("NORMAL", "OTHER", recruiting)).toBe("NORMAL");
    expect(applyPriorityRules("NORMAL", undefined, recruiting)).toBe("NORMAL");
  });

  test("no rules configured is a no-op", () => {
    expect(applyPriorityRules("LOW", "INTERVIEW", undefined)).toBe("LOW");
  });

  test("a rule with no category condition matches every category", () => {
    const catchAll: PriorityRules = {
      label: "test",
      ceilings: [{ when: {}, maxImportance: "NORMAL" }],
    };
    expect(applyPriorityRules("CRITICAL", "ANYTHING", catchAll)).toBe("NORMAL");
  });

  test("a ceiling wins when a category matches both a floor and a ceiling", () => {
    const conflicting: PriorityRules = {
      label: "test",
      floors: [{ when: { category: "X" }, minImportance: "CRITICAL" }],
      ceilings: [{ when: { category: "X" }, maxImportance: "LOW" }],
    };
    expect(applyPriorityRules("NORMAL", "X", conflicting)).toBe("LOW");
  });
});
```

**Verify:** `bun test priority-rules` — all pass. Still no Convex runtime involved.

---

## Step 3 — Connect two more mailboxes

**Not a file — two more runs of `/connect`.**

The OAuth flow already supports arbitrary labels since Phase 3; this phase is "do it two more times," not new code. From Telegram, against **each** deployment you actually use day to day:

```
/connect recruiting
/connect client
```

Each command mints a fresh one-time link. Open each link and **pick a different Google account at the consent screen than the one before it** — if your browser is already signed into the account you just connected, Google will silently reuse it unless you explicitly choose "use another account." Confirm all three are distinct and `ACTIVE`:

```
/accounts
```

should show three rows, three different `accountEmail` values, three different `label` values, all `✅ ACTIVE`.

**If a Testing-mode Google app is in play** (the normal state for a personal project not yet verified by Google), each account's refresh token still expires every 7 days independently — `/reconnect <label>` per account when `notifyNeedsReauth` fires, same as Phase 3.

---

## Step 4 — Wire priority rules in, and sync fairly

**File:** `convex/gmail.ts` **(edit)**

This edit has two independent parts, both inside this one file.

### Part A — apply priority rules between classification and delivery

By now `syncAccount`'s per-message loop (added in Phase 4, extended in Phase 5) classifies each new message and then decides whether to alert on it. In outline, after `emailMessages.upsert` returns `{created: true}`, it looks like this:

```ts
const classified = await classifyMessage(/* prefilter → runTask("CLASSIFY_IMPORTANCE", ...) → SPAM/DMARC override */);

await ctx.runMutation(internal.model.emailMessages.recordClassification, {
  emailMessageId: result.emailMessageId,
  importance: classified.importance,
  classification: classified,
  classifierVersion: CLASSIFIER_VERSION,
});

if (shouldNotifyImmediately(classified.importance, classified.category)) {
  await notify.sendAlert(ctx, { emailMessageId: result.emailMessageId, account });
}
```

Insert `applyPriorityRules` **between** those two calls — after classification, before it is recorded or acted on, using the account's own stored rules:

```ts
import { applyPriorityRules } from "./lib/email/priority";
// ...

const classified = await classifyMessage(/* ... */);

const adjusted = applyPriorityRules(
  classified.importance,
  classified.category,
  account.priorityRules,
);

await ctx.runMutation(internal.model.emailMessages.recordClassification, {
  emailMessageId: result.emailMessageId,
  importance: adjusted,
  classification: classified,
  classifierVersion: CLASSIFIER_VERSION,
});

if (shouldNotifyImmediately(adjusted, classified.category)) {
  await notify.sendAlert(ctx, { emailMessageId: result.emailMessageId, account });
}
```

**Why here and not inside the classifier.** `CLASSIFY_IMPORTANCE` has no idea which of your three mailboxes it is looking at — giving it that context would mean putting account-specific policy into a prompt, which is exactly the "suggestion, not a guarantee" problem this phase exists to close. `adjusted`, not `classified.importance`, is what gets stored and what the delivery rule sees from here on.

### Part B — sync every account concurrently, not one after another

The current cron target awaits each account's full sync before starting the next:

```ts
/** The cron target. One account failing must not stop the others. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});
    for (const account of accounts) {
      try {
        await ctx.runAction(internal.gmail.syncAccount, { accountId: account._id });
      } catch (error) {
        console.warn(
          `gmail_sync_failed account=${account._id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  },
});
```

With one mailbox this was fine. With three, a personal inbox with many new messages runs `syncAccount`'s full `listMessages` + `getMessage`-per-message loop (up to `MAX_PER_SYNC` round trips to Gmail) **to completion** before the recruiting mailbox's very first API call happens — the noisy mailbox starves the one you actually care about, exactly as the build plan warns. Replace the sequential loop with a concurrent one:

```ts
/**
 * The cron target. One account failing must not stop the others, and one
 * account taking a while must not delay the others either.
 *
 * The previous version awaited syncAccount sequentially, so a noisy
 * personal mailbox — many new messages, each needing its own getMessage
 * round trip — ran to completion before the recruiting mailbox's very first
 * Gmail API call. Now every ACTIVE account's sync is in flight at once, so a
 * slow or hanging account can no longer push a fast one out of the tick.
 */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listActive, {});

    await Promise.all(
      accounts.map(async (account) => {
        try {
          await ctx.runAction(internal.gmail.syncAccount, { accountId: account._id });
        } catch (error) {
          console.warn(
            `gmail_sync_failed account=${account._id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  },
});
```

Each account's failure is still caught independently inside its own `.map()` callback, so `Promise.all` never rejects because one account errored — the existing "one account failing must not stop the others" guarantee is unchanged, it now also holds for *slowness*, not just failure.

**Verify:**
- `bun run typecheck` — clean.
- `bunx convex dev --once` pushes without error.
- `/sync` in Telegram, then watch the dev deployment's logs (`bunx convex logs`) — you should see Gmail API calls for all three accounts interleaved in time, not one account's calls finishing before the next account's calls start.

---

## Step 5 — Lock in the mailbox-label guarantee

**File:** `tests/unit/notify-card.test.ts` **(edit)**

Phase 5's `composeCard` already renders the mailbox label as part of the card (`🔴 CRITICAL · recruiting@gmail · ⚠️ found in SPAM`) — this step doesn't add that behavior, it makes it a **test-enforced guarantee** rather than something you'd only notice broke by eyeballing Telegram. "The notification card always names the source mailbox. A card without a mailbox label is a bug" is stated directly in the build plan's security gate for this phase, precisely because it's easy to silently regress once three mailboxes make label mix-ups possible.

Add these cases to the existing file (adjust the field name below — `accountLabel` — if Phase 5 named `composeCard`'s input differently; what matters is the assertion, not the exact argument name):

```ts
import { describe, expect, test } from "bun:test";
import { composeCard } from "../../convex/notify";

const base = {
  importance: "CRITICAL" as const,
  accountLabel: "recruiting",
  inSpam: true,
  from: "Sarah Chen <s.chen@vercel.com>",
  subject: "Interview availability — Senior Frontend Engineer",
  whyItMatters: "Recruiter following up; asks for availability this week.",
  deadlineMentioned: "Thursday 21 Aug",
};

describe("composeCard — Phase 7 mailbox-label guarantee", () => {
  test("every card names its source mailbox", () => {
    expect(composeCard(base)).toContain("recruiting");
  });

  test("a card for a different account never claims the wrong one", () => {
    const card = composeCard({ ...base, accountLabel: "personal" });
    expect(card).toContain("personal");
    expect(card).not.toContain("recruiting");
  });
});
```

If either test fails against the real `composeCard`, that is this phase's actual work on this file: fix `composeCard` (or its input shape) until both pass, rather than editing the test to match broken output.

**Verify:** `bun test notify-card` — both new tests pass.

---

## Step 6 — Audit `accountId` requiredness

**File:** `convex/schema.ts` **(audit only — edit only if something's wrong)**

Convex has no `NOT NULL` to lean on outside push-time validation, so "every mailbox-scoped document always knows which mailbox it belongs to" is only as strong as `v.id(...)` being **required**, not `v.optional`, everywhere it genuinely always applies. With three mailboxes now live, a silently-optional `accountId` is how a message or a draft ends up attributed to the wrong inbox, or no inbox at all.

Read `convex/schema.ts` and confirm each of these against what is actually there:

| Table | Field | Should be | Why |
|---|---|---|---|
| `emailMessages` | `accountId` | `v.id("connectedAccounts")` — required | Every synced message always belongs to exactly one mailbox |
| `drafts` | `accountId` | `v.id("connectedAccounts")` — required | A draft with no account is nonsensical; the field's own comment already says `MUST equal source message accountId` |
| `approvals` | `accountId` | `v.optional(v.id("connectedAccounts"))` — **deliberately optional** | Not every consequential action is email-scoped — Phase 16's `linear.apply_changeset` approval has no mailbox |
| `auditLogs` | `accountId` | `v.optional(v.id("connectedAccounts"))` — **deliberately optional** | A `task.create` audit row has no mailbox either |
| `notifications` | — no `accountId` field at all | correct as-is | A notification carries `emailMessageId`; the mailbox is reached by following `emailMessageId → emailMessages.accountId → connectedAccounts.label`. Adding a second, independent `accountId` here would let the two disagree |

At the time this doc was written, the current `convex/schema.ts` already matches every row of this table — `emailMessages.accountId` and `drafts.accountId` are required, `approvals.accountId` and `auditLogs.accountId` are intentionally optional, and `notifications` has no redundant field to add. **Do not treat that as a reason to skip this step** — the whole point of an audit is that you looked at the file yourself and confirmed it, not that a build doc told you it was fine. If your `schema.ts` has drifted from this table by the time you reach Phase 7, fix the field to match this table and re-run `bunx convex dev --once` to confirm the push-time validator accepts the change against existing data (a required field added to a table that already has rows without it will fail the push — if that happens, backfill first).

**Verify:** you have personally read every row listed above against the real file and confirmed it. No test to run — a schema shape isn't something `bun test` can check without a Convex-connected test harness, which this project doesn't have.

---

## Done when

- [ ] `bun test` — all passing, including the new `priority-rules` and `notify-card` tests
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex deploy` — succeeds
- [ ] `/accounts` shows three `ACTIVE` mailboxes, three distinct labels, three distinct addresses
- [ ] An email sent to the recruiting address and an email sent to the personal address arrive as **separately labelled** Telegram cards, with differentiated priority — the recruiting account's `INTERVIEW`-category floor visibly promotes a message the personal account's rules would leave alone
- [ ] A reply sent on a thread in the recruiting mailbox verifiably sends **from the recruiting address** — checked in the recipient's headers, not just your own logs
- [ ] You personally read `convex/schema.ts` against Step 6's table and confirmed it
- [ ] Cost checkpoint: after 7 days on three mailboxes, check the Convex dashboard's **database bandwidth** (ceiling 1 GB/mo) and **action compute** (ceiling 20 GB-hr/mo). If bandwidth is projecting past ~700 MB, something is re-reading message bodies it doesn't need to — fix that rather than reducing sync frequency

```bash
git add -A && git commit -m "Phase 7: three mailboxes, deterministic priority rules, concurrent sync"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/lib/email/priority.ts` | Deterministic floor/ceiling adjustment of classifier output — a guarantee, not a prompt suggestion. |
| `convex/gmail.ts` | Applies priority rules between classification and delivery; syncs all ACTIVE accounts concurrently so one mailbox cannot delay another. |
| `tests/unit/priority-rules.test.ts` | Every branch of the floor/ceiling engine, in isolation. |
| `tests/unit/notify-card.test.ts` | Structurally guarantees a card always names its source mailbox. |
| `convex/schema.ts` | Audited, not changed — the required-`accountId` guarantee already held. |

---

## Next

**Phase 8 — Push notifications, reconciliation, email actions.** `docs/build/PHASE-08-push-reconciliation-actions.md` — Gmail Pub/Sub push replaces polling for near-real-time delivery, a reconciliation path guarantees push can never silently drop mail, and the first tools that can *change* a message's state (archive, label, trash, forward, unsubscribe) join the read-only ones, all through the approval gate Phase 6 already built.
