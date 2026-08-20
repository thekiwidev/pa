# Phase 16 — Linear

**This phase is conditional.** The source build plan is explicit about this
one: *"External task management, if and only if internal tasks have become
insufficient."* Linear is not a next step you take because Phase 15 finished
— it is a step you take when the internal `tasks`/`projects` tables have
genuinely stopped being enough for real project work. If that day hasn't
come, close this document and keep using `task.create`. Everything below
assumes it has.

**Build documentation.** Follow it top to bottom. Every step names the exact
file, says what that file is for, gives you the content, and tells you how
to check it worked.

- **Architecture reference:** `docs/personal-ai-assistant-build-plan-v3-convex.md`
  → *Phase 16*
- **Prerequisite:** Phase 6 (draft, approve, send) complete. This is the
  first non-email tool this codebase gates behind an approval, and it reuses
  Phase 6's machinery wholesale: `convex/model/approvals.ts` (create/consume),
  `convex/security/hash.ts` (the payload-hash discipline), and — most
  importantly — the *generalized* form of `executeToolCall`'s consequential
  branch in `convex/tools/router.ts`. At the time this document was written,
  Phase 6 had not yet landed, so that branch was still the unconditional
  refusal shown in Step 4. **If you are building this before Phase 6, stop
  and build that first** — `linear.apply_changeset` will compile and run,
  but every call to it will come back "This action needs your explicit
  approval, which is not built yet," because that is what the current branch
  says for *every* consequential tool, Linear included.

---

## What you'll have at the end

You can ask "what's open on the ENG board" and get a real answer. You report
progress on a project by voice or text at the end of the day, the assistant
proposes a batch of Linear issue changes — titles, states, priorities — as
one numbered list, and one approval (not one per issue) applies the whole
batch. Nothing you say to Linear is ever pushed automatically; a batch you
don't approve never touches it.

---

## File manifest

Create or edit these, in this order.

| # | File | New/Edit | What it is |
|---|---|---|---|
| 0 | `convex/debug.ts` | edit | One-time: seal `LINEAR_API_KEY` into a `connectedAccounts` row — there is no OAuth flow to run instead |
| 1 | `convex/connectors/linear/client.ts` | new | Thin GraphQL client: `listIssues`, `getIssue`, `listWorkflowStates`, `applyChangeset` |
| 2 | `tests/unit/linear-client.test.ts` | new | Pure request-shaping tests against the query/mutation builders |
| 3 | `convex/lib/tools/catalog.ts` | edit | `linear.list_issues`, `linear.get_issue`, `linear.propose_changeset`, `linear.apply_changeset` |
| 4 | `convex/tools/router.ts` | edit | Dispatch cases + the state-name resolution and changeset-hash helpers |
| 5 | `convex/lib/tools/outcomes.ts` | edit | Renders the four new tool results as Telegram text |
| 6 | `convex/lib/prompts/assistant.ts` | edit | Remove "Linear" from `SCOPE`'s denial list |
| 7 | `tests/unit/assistant-prompt.test.ts` | edit | Match the new `SCOPE` wording |

`LINEAR_API_KEY` is already set on both deployments (confirmed in
`.env.dev`) — nothing here provisions an environment variable.

---

## Step 0 — One-time: connect the Linear account

**File:** `convex/debug.ts` **(edit)**

**What this does.** Every other `connectedAccounts` row in this codebase is
created by an OAuth callback (`convex/gmail.ts`'s `completeConnect`). Linear
has no handshake — a personal API key is the whole credential — so there is
no `/connect linear` flow to build. The row still gets created the exact
same way every other credential is stored: `seal()` the plaintext, hand only
the ciphertext to `connectedAccounts.upsert`. This runs once per deployment
(dev, then prod), not once per user session.

Add this import alongside the existing ones at the top of `convex/debug.ts`:

```ts
import { internal } from "./_generated/api";
```

(It is very likely already imported — `planOnly` uses it. Skip if so.)

Add this action, near `cryptoSelfTest`:

```ts
/**
 * One-time: seal LINEAR_API_KEY into a connectedAccounts row.
 *
 * Linear has no OAuth handshake for a personal API key — there is no
 * /connect flow to run instead. This IS the entire "connect Linear" step,
 * and connectedAccounts.upsert is already idempotent on
 * (userId, provider, accountEmail), so running this twice just re-seals the
 * same row rather than duplicating it — safe to re-run after rotating the
 * key.
 *
 *   bunx convex run debug:connectLinear '{}'
 */
export const connectLinear = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) throw new Error("LINEAR_API_KEY is not set on this deployment");

    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("owner has no user row yet — message the bot once first");

    const sealed = await seal(apiKey);
    const result = await ctx.runMutation(internal.model.connectedAccounts.upsert, {
      userId: user._id,
      provider: "linear",
      // Linear has no mailbox concept — accountEmail is the identity Gmail
      // uses to tell two accounts of the same provider apart. A stable
      // literal does the same job here, since there is only ever one.
      accountEmail: "linear",
      displayName: "Linear",
      label: "linear",
      encryptedCredentials: sealed.ciphertext,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      scopesGranted: [],
    });

    return { accountId: result.accountId, created: result.created };
  },
});
```

**Verify:** `bunx convex run debug:connectLinear '{}'` on dev returns
`{"created": true}` the first time. Convex dashboard → `connectedAccounts` →
one row, `provider: "linear"`, `status: "ACTIVE"`, `encryptedCredentials` is
ciphertext (not readable). Run the same command again — `created: false`,
same row, no duplicate.

---

## Step 1 — The Linear GraphQL client

**File:** `convex/connectors/linear/client.ts` **(create)**

**What this file is for.** The only place that knows Linear's wire format —
same §0.2 argument as `convex/connectors/gmail/client.ts`: plain `fetch`,
one endpoint, a handful of operations, no SDK, no `"use node"`. The query and
mutation *builders* are exported separately from the functions that call
`fetch`, so `tests/unit/linear-client.test.ts` can assert on the exact
GraphQL shape sent over the wire with no network call and no API key.

```ts
// A thin Linear GraphQL client. No SDK, one endpoint
// (https://api.linear.app/graphql), four operations.
//
// Query/mutation builders (buildXxx) are pure and exported on their own —
// tests/unit/linear-client.test.ts asserts on their output directly. The
// functions that actually call fetch (listIssues, getIssue, ...) are thin
// wrappers around them plus response handling.

const BASE = "https://api.linear.app/graphql";

export class LinearApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`linear ${status}: ${body.slice(0, 300)}`);
    this.name = "LinearApiError";
  }
  /** An invalid, revoked, or malformed personal API key. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; path?: (string | number)[] }[];
}

interface GraphQLResult<T> {
  data: T;
  errors?: { message: string; path?: (string | number)[] }[];
}

async function linearFetch<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResult<T>> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Personal API keys go in Authorization UNPREFIXED. "Bearer <key>" is
      // for OAuth access tokens only — Linear's API rejects a personal key
      // sent that way with an auth error, which reads exactly like a bad
      // key and is easy to misdiagnose as one.
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new LinearApiError(res.status, await res.text());

  const json = (await res.json()) as GraphQLResponse<T>;

  // GraphQL can return HTTP 200 with a populated `errors` array — a status
  // check alone misses a bad query or a resolver failure (e.g. an id that
  // matches nothing). Total failure has no `data` at all; a partial batch
  // failure (some aliased mutations in applyChangeset succeed, one doesn't)
  // has both `data` and `errors` together, so only throw on the former —
  // the latter is applyChangeset's job to sort out per-issue.
  if (!json.data) {
    throw new LinearApiError(200, json.errors?.map((e) => e.message).join("; ") ?? "no data in response");
  }

  return { data: json.data, errors: json.errors };
}

export interface LinearIssueSummary {
  id: string;
  identifier: string; // "ENG-123"
  title: string;
  url: string;
  priority: number; // Linear's own 0-4 scale — see LINEAR_PRIORITY in catalog.ts
  updatedAt: string;
  state: { id: string; name: string };
  assignee?: { name: string } | null;
}

/** Pure. Kept separate from listIssues() so its shape is testable alone. */
export function buildListIssuesQuery(options: {
  teamKey?: string;
  stateName?: string;
  limit?: number;
}): { query: string; variables: Record<string, unknown> } {
  const filter: Record<string, unknown> = {};
  if (options.teamKey) filter.team = { key: { eq: options.teamKey } };
  if (options.stateName) filter.state = { name: { eq: options.stateName } };

  return {
    query: `
      query ListIssues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            url
            priority
            updatedAt
            state { id name }
            assignee { name }
          }
        }
      }
    `,
    variables: { filter, first: options.limit ?? 10 },
  };
}

export async function listIssues(
  apiKey: string,
  options: { teamKey?: string; stateName?: string; limit?: number },
): Promise<LinearIssueSummary[]> {
  const { query, variables } = buildListIssuesQuery(options);
  const { data } = await linearFetch<{ issues: { nodes: LinearIssueSummary[] } }>(
    apiKey,
    query,
    variables,
  );
  return data.issues.nodes;
}

export interface LinearIssueDetail extends LinearIssueSummary {
  description?: string | null;
  team: { id: string; key: string };
}

/**
 * Pure. `id` accepts EITHER a Linear UUID or the human identifier
 * ("ENG-123") — Linear's `issue` query resolves both, so nothing upstream
 * of this file ever needs to know which one it was handed. Same idea as
 * `email.get_message`'s emailMessageId, one level up.
 */
export function buildGetIssueQuery(id: string): { query: string; variables: Record<string, unknown> } {
  return {
    query: `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          url
          priority
          updatedAt
          description
          state { id name }
          assignee { name }
          team { id key }
        }
      }
    `,
    variables: { id },
  };
}

export async function getIssue(apiKey: string, id: string): Promise<LinearIssueDetail | null> {
  const { query, variables } = buildGetIssueQuery(id);
  try {
    const { data } = await linearFetch<{ issue: LinearIssueDetail | null }>(apiKey, query, variables);
    return data.issue;
  } catch (error) {
    // An id matching nothing surfaces as a GraphQL error with no `data` at
    // all (non-nullable `issue` field), not a bare null — translate it to
    // "not found" the same way a missing row reads everywhere else here.
    if (error instanceof LinearApiError && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export interface LinearWorkflowState {
  id: string;
  name: string;
}

/**
 * Pure. `linear.propose_changeset` never lets the model supply a Linear
 * state id directly — see resolveStateId in tools/router.ts — this is the
 * lookup that resolution needs.
 */
export function buildWorkflowStatesQuery(teamKey: string): { query: string; variables: Record<string, unknown> } {
  return {
    query: `
      query WorkflowStates($teamKey: String!) {
        team(id: $teamKey) {
          states(first: 50) { nodes { id name } }
        }
      }
    `,
    variables: { teamKey },
  };
}

export async function listWorkflowStates(apiKey: string, teamKey: string): Promise<LinearWorkflowState[]> {
  const { query, variables } = buildWorkflowStatesQuery(teamKey);
  const { data } = await linearFetch<{ team: { states: { nodes: LinearWorkflowState[] } } | null }>(
    apiKey,
    query,
    variables,
  );
  return data.team?.states.nodes ?? [];
}

export interface LinearIssueChange {
  issueId: string; // UUID or identifier — same rule as getIssue's id
  title?: string;
  description?: string;
  stateId?: string; // resolved ahead of time — see resolveStateId
  stateName?: string; // display-only echo of what the user asked for; ignored by the mutation
  priority?: number; // Linear's native 0-4 scale
}

export interface LinearChangeResult {
  issueId: string;
  success: boolean;
  identifier?: string;
  error?: string;
}

/**
 * Pure. One `issueUpdate` per change, ALIASED into a single GraphQL
 * request. This IS the batch — one HTTP call, one approval, not N. Linear
 * has no native "update these N different issues with N different diffs"
 * mutation; aliasing heterogeneous mutations into one request is the
 * standard way to batch them in a single GraphQL round trip.
 */
export function buildApplyChangesetMutation(
  changes: LinearIssueChange[],
): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};

  const fields = changes.map((change, i) => {
    const alias = `c${i}`;
    variables[`${alias}Id`] = change.issueId;
    variables[`${alias}Input`] = {
      ...(change.title !== undefined ? { title: change.title } : {}),
      ...(change.description !== undefined ? { description: change.description } : {}),
      ...(change.stateId !== undefined ? { stateId: change.stateId } : {}),
      ...(change.priority !== undefined ? { priority: change.priority } : {}),
    };
    return `${alias}: issueUpdate(id: $${alias}Id, input: $${alias}Input) { success issue { id identifier } }`;
  });

  const varDecls = changes
    .map((_, i) => `$c${i}Id: String!, $c${i}Input: IssueUpdateInput!`)
    .join(", ");

  return {
    query: `mutation ApplyChangeset(${varDecls}) {\n  ${fields.join("\n  ")}\n}`,
    variables,
  };
}

export async function applyChangeset(
  apiKey: string,
  changes: LinearIssueChange[],
): Promise<LinearChangeResult[]> {
  if (changes.length === 0) return [];

  const { query, variables } = buildApplyChangesetMutation(changes);
  const { data, errors } = await linearFetch<
    Record<string, { success: boolean; issue?: { id: string; identifier: string } } | null>
  >(apiKey, query, variables);

  // Per-issue, not all-or-nothing: a batch of five where one issue was
  // deleted out from under the proposal should not silently drop the other
  // four — each alias's own result (or its own entry in `errors`) decides.
  return changes.map((change, i) => {
    const alias = `c${i}`;
    const result = data[alias];
    if (result?.success) {
      return { issueId: change.issueId, success: true, identifier: result.issue?.identifier };
    }
    const failure = errors?.find((e) => e.path?.[0] === alias);
    return { issueId: change.issueId, success: false, error: failure?.message ?? "update failed" };
  });
}
```

**Verify:** `bun run typecheck` passes. No `bun test` yet — Step 2 writes
the tests this file needs.

---

## Step 2 — Client tests (pure)

**File:** `tests/unit/linear-client.test.ts` **(create)**

**What this file is for.** Request-shaping only — the same discipline as
`tests/unit/gmail-normalize.test.ts`: assert on exactly what gets built, no
network, no API key.

```ts
import { describe, expect, test } from "bun:test";
import {
  buildListIssuesQuery,
  buildGetIssueQuery,
  buildWorkflowStatesQuery,
  buildApplyChangesetMutation,
  type LinearIssueChange,
} from "../../convex/connectors/linear/client";

describe("buildListIssuesQuery", () => {
  test("defaults to no filter and a limit of 10", () => {
    const { variables } = buildListIssuesQuery({});
    expect(variables).toEqual({ filter: {}, first: 10 });
  });

  test("filters by team key and state name together", () => {
    const { variables } = buildListIssuesQuery({ teamKey: "ENG", stateName: "In Progress" });
    expect(variables.filter).toEqual({
      team: { key: { eq: "ENG" } },
      state: { name: { eq: "In Progress" } },
    });
  });

  test("honours an explicit limit", () => {
    const { variables } = buildListIssuesQuery({ limit: 25 });
    expect(variables.first).toBe(25);
  });

  test("query text requests the fields the router depends on", () => {
    const { query } = buildListIssuesQuery({});
    expect(query).toContain("identifier");
    expect(query).toContain("state { id name }");
  });
});

describe("buildGetIssueQuery", () => {
  test("passes a UUID through untouched", () => {
    const { variables } = buildGetIssueQuery("a1b2c3d4-0000-0000-0000-000000000000");
    expect(variables).toEqual({ id: "a1b2c3d4-0000-0000-0000-000000000000" });
  });

  test("passes a human identifier through the same way", () => {
    const { variables } = buildGetIssueQuery("ENG-123");
    expect(variables).toEqual({ id: "ENG-123" });
  });
});

describe("buildWorkflowStatesQuery", () => {
  test("takes a team key as the id argument", () => {
    const { variables } = buildWorkflowStatesQuery("ENG");
    expect(variables).toEqual({ teamKey: "ENG" });
  });
});

describe("buildApplyChangesetMutation", () => {
  test("aliases one issueUpdate per change, in order", () => {
    const changes: LinearIssueChange[] = [
      { issueId: "ENG-1", title: "New title" },
      { issueId: "ENG-2", priority: 2 },
    ];
    const { query } = buildApplyChangesetMutation(changes);
    expect(query).toContain("c0: issueUpdate(id: $c0Id, input: $c0Input)");
    expect(query).toContain("c1: issueUpdate(id: $c1Id, input: $c1Input)");
  });

  test("only includes fields that were actually set", () => {
    const { variables } = buildApplyChangesetMutation([{ issueId: "ENG-1", priority: 1 }]);
    expect(variables.c0Input).toEqual({ priority: 1 });
    expect(variables.c0Id).toBe("ENG-1");
  });

  test("carries stateId into the mutation input but never stateName", () => {
    const { variables } = buildApplyChangesetMutation([
      { issueId: "ENG-1", stateId: "state-uuid", stateName: "Done" },
    ]);
    expect(variables.c0Input).toEqual({ stateId: "state-uuid" });
  });

  test("declares one typed variable pair per change", () => {
    const { query } = buildApplyChangesetMutation([
      { issueId: "ENG-1" },
      { issueId: "ENG-2" },
      { issueId: "ENG-3" },
    ]);
    expect(query).toContain(
      "mutation ApplyChangeset($c0Id: String!, $c0Input: IssueUpdateInput!, " +
        "$c1Id: String!, $c1Input: IssueUpdateInput!, " +
        "$c2Id: String!, $c2Input: IssueUpdateInput!)",
    );
  });

  test("an empty batch still builds a syntactically valid (empty) mutation", () => {
    const { query, variables } = buildApplyChangesetMutation([]);
    expect(variables).toEqual({});
    expect(query).toContain("mutation ApplyChangeset()");
  });
});
```

**Verify:** `bun test tests/unit/linear-client.test.ts` — all passing. No
Convex running, no network, no `LINEAR_API_KEY` needed.

---

## Step 3 — Tool catalog

**File:** `convex/lib/tools/catalog.ts` **(edit)**

**What this does.** Four new entries in `TOOL_SCHEMAS` and `TOOL_META`,
following the exact pattern every earlier tool used. `linear.apply_changeset`
takes `changesetId` OR `changes` — the same duality as `TASK_REF`'s
`taskId`/`taskTitle`, for the same reason: a batch approved a minute ago has
an id worth reusing, but "yes, do those three things" proposed and approved
in the same breath never got a chance to round-trip through
`linear.propose_changeset` first.

Add these consts right after the `TASK_REF`/`needsTaskRef`/`TASK_REF_ERROR`
block (same section, same shape, so the two id-or-X patterns sit together):

```ts
/**
 * An issue is addressed by Linear's own UUID OR its human identifier
 * ("ENG-123") — Linear's API resolves either, so the router passes
 * whichever one it was given straight through without normalizing it.
 */
const LINEAR_ISSUE_REF = z
  .string()
  .min(1)
  .describe('Linear issue id or identifier, e.g. "ENG-123"');

/**
 * Linear's OWN priority scale — 0 (none) to 4 (low), urgency DEscending.
 * This is a different scale from PRIORITY above (1=critical...5=lowest,
 * urgency AScending) — do not reuse PRIORITY here, the numbers mean the
 * opposite thing.
 */
const LINEAR_PRIORITY = z
  .preprocess((value) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return value;
    const asNumber = Number(value.trim());
    if (!Number.isNaN(asNumber)) return asNumber;
    const words: Record<string, number> = {
      none: 0, no_priority: 0,
      urgent: 1, critical: 1,
      high: 2,
      medium: 3, normal: 3,
      low: 4, minor: 4,
    };
    return words[value.trim().toLowerCase().replace(/\s+/g, "_")] ?? value;
  }, z.number().int().min(0).max(4))
  .describe('Linear\'s own scale: 0=none 1=urgent 2=high 3=medium 4=low, or the words');

/**
 * One issue's proposed diff. `stateName` — never an id — the same "resolve
 * a name in code, never trust an id the model invented" rule that
 * projectName and taskTitle already follow elsewhere in this file.
 */
const LINEAR_CHANGE = z.object({
  issueRef: LINEAR_ISSUE_REF,
  title: z.string().optional().describe("new title"),
  description: z.string().optional().describe("new description"),
  stateName: z
    .string()
    .optional()
    .describe('target workflow state, e.g. "Done" or "In Progress" — the literal Linear state name for that issue\'s team'),
  priority: LINEAR_PRIORITY.optional(),
});

const needsChangesetRef = <T extends { changesetId?: string; changes?: unknown[] }>(value: T) =>
  Boolean(value.changesetId || (value.changes && value.changes.length > 0));
const CHANGESET_REF_ERROR = { message: "give either changesetId or changes" };
```

Add these four entries at the end of `TOOL_SCHEMAS`, after `"instruction.remove"`:

```ts
  "linear.list_issues": z.object({
    teamKey: z.string().optional().describe('Linear team key, e.g. "ENG" — omit to search every team the key can see'),
    stateName: z.string().optional().describe('workflow state name, e.g. "In Progress" — a literal Linear state, not a judgement call'),
    limit: z.number().int().min(1).max(25).optional().describe("default 10"),
  }),
  "linear.get_issue": z.object({
    issueRef: LINEAR_ISSUE_REF,
  }),
  "linear.propose_changeset": z.object({
    changes: z.array(LINEAR_CHANGE).min(1).describe("one entry per issue to change — builds the batch only, does not touch Linear"),
    summary: z.string().min(1).describe('one sentence describing the whole batch, e.g. "move 3 issues to Done after the deploy" — shown on the approval card'),
  }),
  "linear.apply_changeset": z
    .object({
      changesetId: z.string().min(1).optional().describe("id from a linear.propose_changeset result, once the user has approved it"),
      changes: z.array(LINEAR_CHANGE).min(1).optional().describe("re-state the batch directly, only when proposing and applying in the same breath"),
    })
    .refine(needsChangesetRef, CHANGESET_REF_ERROR),
```

Add these four entries at the end of `TOOL_META`, after `"instruction.remove"`:

```ts
  "linear.list_issues": {
    description: "List Linear issues, optionally filtered by team or workflow state. Read-only.",
    consequential: false,
    requiresAccountId: false,
  },
  "linear.get_issue": {
    description: "Full detail of one Linear issue by id or identifier (e.g. ENG-123).",
    consequential: false,
    requiresAccountId: false,
  },
  "linear.propose_changeset": {
    description:
      "Build a batch of Linear issue changes for the user to review and " +
      "approve in one tap. Does not touch Linear. Use this whenever the " +
      "user reports progress on project work and it implies issue updates " +
      "— never call linear.apply_changeset without a changeset from this " +
      "first, in the same plan or an earlier one.",
    consequential: false,
    requiresAccountId: false,
  },
  "linear.apply_changeset": {
    description:
      "Apply a previously-proposed batch of Linear issue changes. " +
      "Consequential — this always needs the user's explicit approval and " +
      "cannot run on your own proposal alone.",
    consequential: true,
    requiresAccountId: false,
  },
```

**Verify:** `bun run typecheck` passes. `bun test tests/unit/tool-plan.test.ts`
still passes unmodified — new tools don't change how parsing works, only
what it accepts.

---

## Step 4 — Router

**File:** `convex/tools/router.ts` **(edit)**

**What this does.** Everything that actually talks to Linear. Three pieces:
a helper to get the decrypted API key, the state-name-to-id resolution that
keeps the model from ever inventing a Linear id, and the four dispatch
cases.

**On the consequential gate, precisely.** `executeToolCall`'s current branch
(shown below, unchanged by this phase) refuses every consequential tool
unconditionally:

```ts
  if (meta.consequential) {
    await audit(ctx, call, "denied", startedAt, "consequential tool without approval");
    return {
      name: call.name,
      ok: false,
      result: { error: "This action needs your explicit approval, which is not built yet." },
    };
  }
```

Phase 6 generalizes this branch — for *any* consequential tool, not
Linear specifically — into: look up a live `PENDING` approval matching this
exact tool and target; if none exists, create one and return "awaiting your
approval" without executing anything; if a matching `CONSUMED` approval
exists (the real approve-and-run path, e.g. a `[Approve]` button tap),
proceed to `dispatch()`. Linear needs **zero changes** to that branch — by
design, it already treats every consequential tool identically by its
`action` name. What this phase adds is only the `dispatch()` case that runs
once execution is allowed, and one new value the branch's `action` field can
carry: `"linear.apply_changeset"`. If you're reading this before Phase 6
exists, the case below is correct but inert — it's just currently
unreachable, the same way `email.send_reply`'s Phase 6 case would be.

Add these imports at the top, alongside the existing ones:

```ts
import { open } from "../security/crypto";
import {
  listIssues,
  getIssue,
  listWorkflowStates,
  applyChangeset,
  type LinearIssueChange,
} from "../connectors/linear/client";
```

Add these helpers near `resolveTaskId` (same section — id/name resolution
that runs in code, never trusting the model):

```ts
/**
 * Linear has exactly one connected account per deployment — no OAuth, no
 * label to disambiguate — so a provider lookup is enough. Unlike Gmail's
 * resolveAccountIds, there is nothing to pick between.
 */
async function linearApiKey(ctx: ActionCtx, userId: Id<"users">): Promise<string> {
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const account = accounts.find((a) => a.provider === "linear" && a.status === "ACTIVE");
  if (!account) {
    throw new Error(
      "No Linear account connected. Run `bunx convex run debug:connectLinear` " +
        "once to seal LINEAR_API_KEY into a connectedAccounts row.",
    );
  }
  return await open({
    ciphertext: account.encryptedCredentials,
    iv: account.credentialIv,
    authTag: account.credentialAuthTag,
  });
}

/**
 * "Move it to Done" names a STATE, not an id — and different teams can
 * have differently-worded states, so this is resolved from the issue's own
 * team, in code, exactly like a taskTitle or projectName is resolved
 * before anything is written (I-3). The model never sees or invents a
 * Linear state id.
 */
async function resolveStateId(apiKey: string, issueRef: string, stateName: string): Promise<string> {
  const issue = await getIssue(apiKey, issueRef);
  if (!issue) throw new Error(`no Linear issue matching "${issueRef}"`);

  const states = await listWorkflowStates(apiKey, issue.team.key);
  const match = states.find((s) => s.name.toLowerCase() === stateName.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `${issue.team.key} has no workflow state named "${stateName}" ` +
        `(has: ${states.map((s) => s.name).join(", ")})`,
    );
  }
  return match.id;
}

async function toLinearChanges(
  apiKey: string,
  rawChanges: Array<Record<string, unknown>>,
): Promise<LinearIssueChange[]> {
  return await Promise.all(
    rawChanges.map(async (c) => ({
      issueId: c.issueRef as string,
      title: c.title as string | undefined,
      description: c.description as string | undefined,
      stateName: c.stateName as string | undefined,
      stateId:
        typeof c.stateName === "string" && c.stateName.length > 0
          ? await resolveStateId(apiKey, c.issueRef as string, c.stateName)
          : undefined,
      priority: c.priority as number | undefined,
    })),
  );
}

/**
 * Same SHA-256-via-Web-Crypto primitive Phase 6's convex/security/hash.ts
 * uses for a draft, shaped for a Linear batch instead: every field that
 * changes what gets sent to Linear, concatenated in a fixed order, so the
 * same batch always hashes the same way regardless of key order in the
 * model's JSON, and an edited batch never matches a stale approval.
 */
async function changesetHash(changes: LinearIssueChange[]): Promise<string> {
  const canonical = changes
    .map((c) =>
      [c.issueId, c.title ?? "", c.description ?? "", c.stateId ?? "", c.priority ?? ""].join(" "),
    )
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * changesetId OR changes — the same duality as resolveTaskId's
 * taskId/taskTitle, for the same reason: a batch proposed a minute ago has
 * an id worth reusing; a batch proposed and approved in the same breath
 * never got a chance to round-trip through linear.propose_changeset first.
 *
 * The batch itself lives in `preferences` under a content-addressed key —
 * reusing an existing generic table rather than adding a new one, the same
 * call PHASE-05B's brief config makes for the exact same reason.
 */
async function resolveChangeset(
  ctx: ActionCtx,
  userId: Id<"users">,
  args: Record<string, unknown>,
): Promise<LinearIssueChange[]> {
  if (typeof args.changesetId === "string" && args.changesetId.length > 0) {
    const rows = await ctx.runQuery(internal.model.preferences.all, { userId });
    const stored = rows.find((p) => p.key === `linear_changeset:${args.changesetId}`);
    if (!stored) throw new Error(`no proposed changeset "${args.changesetId}" — propose one first`);
    return (stored.value as { changes: LinearIssueChange[] }).changes;
  }

  if (Array.isArray(args.changes)) {
    const apiKey = await linearApiKey(ctx, userId);
    return await toLinearChanges(apiKey, args.changes as Array<Record<string, unknown>>);
  }

  throw new Error("no changesetId or changes given");
}
```

Add these four cases to `dispatch()`'s `switch`, after `"instruction.remove"`:

```ts
    case "linear.list_issues": {
      const apiKey = await linearApiKey(ctx, userId);
      return await listIssues(apiKey, {
        teamKey: a.teamKey as string | undefined,
        stateName: a.stateName as string | undefined,
        limit: (a.limit as number | undefined) ?? 10,
      });
    }

    case "linear.get_issue": {
      const apiKey = await linearApiKey(ctx, userId);
      const issue = await getIssue(apiKey, a.issueRef as string);
      if (!issue) return { found: false };
      return { found: true, ...issue };
    }

    case "linear.propose_changeset": {
      const apiKey = await linearApiKey(ctx, userId);
      const changes = await toLinearChanges(apiKey, a.changes as Array<Record<string, unknown>>);
      const changesetId = await changesetHash(changes);

      // Reused, not a new table — see resolveChangeset's comment above.
      await ctx.runMutation(internal.model.preferences.set, {
        userId,
        key: `linear_changeset:${changesetId}`,
        value: { changes, summary: a.summary, createdAt: Date.now() },
      });

      return { changesetId, summary: a.summary, changes };
    }

    case "linear.apply_changeset": {
      // Reached only once Phase 6's consequential gate has already matched
      // this exact call to a CONSUMED approval — dispatch's job here is
      // only to execute, never to re-decide whether it's allowed to.
      const changes = await resolveChangeset(ctx, userId, a);
      const apiKey = await linearApiKey(ctx, userId);
      const results = await applyChangeset(apiKey, changes);
      return { results };
    }
```

**Verify:** `bun run typecheck` passes. Then, against the real dev
deployment (per the standing lesson that pure-renderer tests don't catch
router wiring bugs):

```bash
bunx convex run debug:planOnly '{"text":"what is open on the ENG board"}'
```

The `executed_would_be` array should show one `linear.list_issues` call with
no invented arguments. If Phase 6 is already built, run it with
`"execute":true` and confirm real issues come back. Then:

```bash
bunx convex run debug:planOnly '{"text":"I finished the auth migration, move ENG-41 to Done, and mark ENG-52 as high priority","execute":true}'
```

`outcomes` should show one `linear.propose_changeset` call whose result
carries a `changesetId` and two resolved changes — `ENG-41` with a real
`stateId` (not the literal string "Done"), `ENG-52` with `priority: 2`.

---

## Step 5 — Outcomes

**File:** `convex/lib/tools/outcomes.ts` **(edit)**

**What this does.** Turns the four new raw results into the text the user
actually reads, the same replace-a-second-model-call discipline as every
other tool here.

Add these helpers near the top, after `str`:

```ts
/** Linear's OWN scale, 0-4 — see the note on LINEAR_PRIORITY in catalog.ts. */
const LINEAR_PRIORITY_WORDS = ["No priority", "Urgent", "High", "Medium", "Low"];

function linearPriorityWord(p: unknown): string {
  return typeof p === "number" && LINEAR_PRIORITY_WORDS[p] ? LINEAR_PRIORITY_WORDS[p]! : "?";
}

function renderLinearIssueRow(m: unknown): string {
  const state = str(field(m, "state"), "name") ?? "?";
  const assigneeName = str(field(m, "assignee"), "name");
  return (
    `• ${str(m, "identifier") ?? "?"} — ${str(m, "title") ?? "(untitled)"} ` +
    `[${state}, ${linearPriorityWord(field(m, "priority"))}]` +
    (assigneeName ? ` — ${assigneeName}` : "")
  );
}
```

Add these four cases to `renderOne`'s `switch`, before `default`:

```ts
    case "linear.list_issues": {
      const rows = Array.isArray(r) ? r : [];
      if (rows.length === 0) return "No matching Linear issues.";
      return rows.map(renderLinearIssueRow).join("\n");
    }

    case "linear.get_issue": {
      if (field(r, "found") !== true) return "No Linear issue matching that id.";
      const description = str(r, "description");
      return [
        `${str(r, "identifier") ?? "?"} — ${str(r, "title") ?? "(untitled)"}`,
        `State: ${str(field(r, "state"), "name") ?? "?"}   Priority: ${linearPriorityWord(field(r, "priority"))}`,
        String(field(r, "url") ?? ""),
        "",
        description || "(no description)",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "linear.propose_changeset": {
      const rows = field(r, "changes");
      const changes = Array.isArray(rows) ? rows : [];
      const lines = changes.map((c, i) => {
        const target = str(c, "stateName");
        const parts = [
          str(c, "title") ? `title → "${str(c, "title")}"` : "",
          target ? `state → ${target}` : "",
          typeof field(c, "priority") === "number" ? `priority → ${linearPriorityWord(field(c, "priority"))}` : "",
        ].filter(Boolean);
        return `  ${i + 1}. ${str(c, "issueId") ?? "?"}: ${parts.join(", ") || "(no field changes)"}`;
      });
      return [
        `📋 Proposed batch — ${str(r, "summary") ?? ""} (${changes.length} issue${changes.length === 1 ? "" : "s"}):`,
        ...lines,
        `Say "approved" to apply it — changeset ${str(r, "changesetId") ?? "?"}.`,
      ].join("\n");
    }

    case "linear.apply_changeset": {
      const rows = field(r, "results");
      const results = Array.isArray(rows) ? rows : [];
      const okCount = results.filter((x) => field(x, "success") === true).length;
      const lines = results.map((x) =>
        field(x, "success") === true
          ? `  ✅ ${str(x, "identifier") ?? str(x, "issueId")}`
          : `  ⚠️ ${str(x, "issueId") ?? "?"} — ${str(x, "error") ?? "failed"}`,
      );
      return [`Applied ${okCount}/${results.length} changes to Linear:`, ...lines].join("\n");
    }
```

**Verify:** `bun run typecheck` passes. `bun test tests/unit/tool-outcomes.test.ts`
still passes unmodified — existing renderers are untouched.

---

## Step 6 — Scope

**File:** `convex/lib/prompts/assistant.ts` **(edit)**

**What this does.** `SCOPE`'s denial list currently states, as fact, that
there is no Linear tool. That stops being true. Remove "Linear" from the
list — leave Calendar, Drive, and WhatsApp exactly as they are; those are
other phases' jobs.

Find:

```ts
  - NO tool for Calendar, Drive, Linear, WhatsApp, or sending/deleting email.
    These are not "not working yet" — they do not exist as tools at all.
```

Replace with:

```ts
  - NO tool for Calendar, Drive, WhatsApp, or sending/deleting email. These
    are not "not working yet" — they do not exist as tools at all. Linear
    IS connected: you can list and read issues and propose a batch of
    changes, but linear.apply_changeset always needs the user's explicit
    approval of that exact batch — the same rule as sending an email.
```

**Verify:** `bun run typecheck` passes. `bun test tests/unit/assistant-prompt.test.ts`
fails — Step 7 fixes it.

---

## Step 7 — Scope test

**File:** `tests/unit/assistant-prompt.test.ts` **(edit)**

Find:

```ts
  test("states scope boundaries: no code, no infra, no Calendar/Drive/send", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("NO ability to write, read, or change code");
    expect(prompt).toContain("Google Cloud Console");
    expect(prompt).toContain("Calendar, Drive, Linear, WhatsApp");
    expect(prompt).toContain('Never say "I am checking / investigating');
  });
```

Replace with:

```ts
  test("states scope boundaries: no code, no infra, no Calendar/Drive/send", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("NO ability to write, read, or change code");
    expect(prompt).toContain("Google Cloud Console");
    expect(prompt).toContain("Calendar, Drive, WhatsApp");
    expect(prompt).toContain('Never say "I am checking / investigating');
  });

  test("states Linear is connected but a batch apply still needs approval", () => {
    const prompt = planningSystemPrompt(base);
    expect(prompt).toContain("Linear");
    expect(prompt).toContain("IS connected");
    expect(prompt).toContain("linear.apply_changeset always needs the user's explicit approval");
  });
```

**Verify:** `bun test` — every suite passes, including the two above.

---

## Done when

- [ ] `bun test` — all suites pass, including the new `linear-client.test.ts`
- [ ] `bun run typecheck` — clean
- [ ] `bunx convex deploy` — succeeds
- [ ] `bunx convex run debug:connectLinear '{}'` — one `connectedAccounts`
      row, `provider: "linear"`, `status: "ACTIVE"`
- [ ] "What's open on the ENG board" (swap in a real team key) returns real
      issues, from your phone
- [ ] An evening message reporting progress on 2-3 issues produces one
      `📋 Proposed batch` card, not one message per issue
- [ ] Saying "approved" applies the whole batch in one call and reports
      per-issue success/failure — confirm in Linear itself that the issues
      actually changed
- [ ] A batch referencing an issue moved or deleted out from under it since
      proposal still applies the rest and reports that one issue's failure,
      not a total abort
- [ ] `auditLogs` has a row for the `linear.apply_changeset` call, `actor:
      "llm_proposed"`, `result: "ok"`

```bash
git add -A && git commit -m "Phase 16: Linear read/list/propose/apply, batch-approved"
```

---

## What each file does, one line each

| File | Responsibility |
|---|---|
| `convex/connectors/linear/client.ts` | Speaks Linear's GraphQL API. Nothing else in the codebase does. |
| `convex/debug.ts` | Adds the one-time `connectLinear` operator action — no OAuth flow exists for this provider. |
| `convex/lib/tools/catalog.ts` | The four new tool contracts — names, argument types, whether each is consequential. |
| `convex/tools/router.ts` | Decrypts the key, resolves state names to ids in code, persists and re-reads a proposed batch, executes the approved one. |
| `convex/lib/tools/outcomes.ts` | Turns a Linear result into the sentence (or card) the user reads. |
| `convex/lib/prompts/assistant.ts` | Tells the model Linear tools now exist, and that applying still needs approval. |

---

## Next

**Phase 17 — Memory 2.0**, also conditional — build it only once structured
relational retrieval is measurably failing (the source plan's own trigger:
more than 20% of context queries failing, or 500+ documents/notes), not out
of enthusiasm for embeddings. Until then, `searchIndex` is worth trying
before `vectorSearch` for anything that looks like a retrieval gap.
