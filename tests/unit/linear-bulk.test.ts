import { describe, expect, test } from "bun:test";
import { buildListIssuesQuery, OPEN_STATE_TYPES } from "../../convex/connectors/linear/client";
import { stateTypesForFilter } from "../../convex/lib/tasks/backend";
import { renderOutcomes } from "../../convex/lib/tools/outcomes";

describe("open-issue listing is filtered on the server", () => {
  test("state categories go into the GraphQL filter", () => {
    const { variables, query } = buildListIssuesQuery({ stateTypes: OPEN_STATE_TYPES, limit: 50 });
    expect(variables.filter).toEqual({
      state: { type: { in: ["triage", "backlog", "unstarted", "started"] } },
    });
    expect(query).toContain("pageInfo { hasNextPage endCursor }");
    expect(query).toContain("project { id name }");
  });
  test("project, no-project, label and cursor", () => {
    expect(buildListIssuesQuery({ projectName: "Migrants Shopping" }).variables.filter).toEqual({
      project: { name: { eqIgnoreCase: "Migrants Shopping" } },
    });
    expect(buildListIssuesQuery({ noProject: true }).variables.filter).toEqual({ project: { null: true } });
    expect(buildListIssuesQuery({ labelName: "MLS" }).variables.filter).toEqual({
      labels: { some: { name: { eqIgnoreCase: "MLS" } } },
    });
    expect(buildListIssuesQuery({ after: "abc" }).variables.after).toBe("abc");
  });
});

describe("stateTypesForFilter", () => {
  test("no status means every open category", () => {
    expect(stateTypesForFilter(undefined, false)).toEqual(["triage", "backlog", "unstarted", "started"]);
  });
  test("includeDone drops the filter", () => {
    expect(stateTypesForFilter(undefined, true)).toBeUndefined();
  });
  test("WAITING is Todo; PLANNED includes triage", () => {
    expect(stateTypesForFilter("WAITING", false)).toEqual(["unstarted"]);
    expect(stateTypesForFilter("PLANNED", false)).toEqual(["triage", "backlog"]);
  });
});

describe("task outcomes", () => {
  test("a Linear list states its total and groups by project", () => {
    const text = renderOutcomes("", [
      {
        name: "task.list",
        ok: true,
        result: {
          total: 2,
          truncated: false,
          tasks: [
            { taskId: "THE-1", title: "Cart", stateName: "Todo", project: "Migrants Shopping" },
            { taskId: "THE-2", title: "Loose", stateName: "In Progress" },
          ],
        },
      },
    ]);
    expect(text).toContain("2 tasks:");
    expect(text).toContain("Migrants Shopping:");
    expect(text).toContain("No project:");
  });
  test("a bulk card never reads as done", () => {
    const text = renderOutcomes("", [
      {
        name: "task.bulk_update",
        ok: true,
        result: { matched: 8, toChange: 8, awaitingApproval: true, changes: ["THE-1 Cart: Todo → Done"] },
      },
    ]);
    expect(text).toContain("Nothing has changed yet");
  });
  test("apply reports what the board shows afterwards", () => {
    const text = renderOutcomes("", [
      {
        name: "linear.apply_changeset",
        ok: true,
        result: {
          created: [],
          results: [{ issueId: "a", success: true, identifier: "THE-1" }],
          verification: { checked: 1, matched: 0, mismatched: [{ identifier: "THE-1", state: "Todo" }] },
        },
      },
    ]);
    expect(text).toContain("did NOT move");
    expect(text).toContain("THE-1 is still Todo");
  });
});
