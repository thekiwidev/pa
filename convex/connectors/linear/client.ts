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
