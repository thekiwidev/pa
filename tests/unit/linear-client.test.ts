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
