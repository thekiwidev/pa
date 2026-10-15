import { describe, expect, test } from "bun:test";
import { claimsCompletedAction, isWriteTool, unbackedClaim } from "../../convex/lib/assistant/claims";

describe("claimsCompletedAction", () => {
  test("catches the 2026-10-15 reply", () => {
    expect(
      claimsCompletedAction("Done — I moved all your current Linear backlog issues to Done."),
    ).toBe(true);
  });
  test("catches passive and perfect forms", () => {
    expect(claimsCompletedAction("All 8 have been moved to Done.")).toBe(true);
    expect(claimsCompletedAction("I've archived it.")).toBe(true);
  });
  test("leaves offers and questions alone", () => {
    expect(claimsCompletedAction("8 tasks ready — tap Apply to move them.")).toBe(false);
    expect(claimsCompletedAction("Want me to mark it done?")).toBe(false);
    expect(claimsCompletedAction("You have 7 open tasks.")).toBe(false);
  });
});

describe("isWriteTool", () => {
  test("reads are not writes", () => {
    for (const name of ["task.list", "email.search", "linear.get_issue", "saved.search", "saved.recent", "list.query"]) {
      expect(isWriteTool(name)).toBe(false);
    }
  });
  test("writes are writes", () => {
    // link.read files the post, so "I saved it" after one is a true claim.
    for (const name of ["task.complete", "task.bulk_update", "email.archive", "context.set", "link.read", "list.mark_done"]) {
      expect(isWriteTool(name)).toBe(true);
    }
  });
});

describe("unbackedClaim", () => {
  const claim = "Done — I moved everything to Done.";
  test("no tools at all → unbacked", () => {
    expect(unbackedClaim(claim, [])).toBe(true);
  });
  test("only a read ran → unbacked", () => {
    expect(unbackedClaim(claim, [{ name: "task.list", ok: true, result: { total: 0 } }])).toBe(true);
  });
  test("a card awaiting Apply → unbacked", () => {
    expect(
      unbackedClaim(claim, [{ name: "task.bulk_update", ok: true, result: { awaitingApproval: true } }]),
    ).toBe(true);
  });
  test("a failed write → unbacked", () => {
    expect(unbackedClaim(claim, [{ name: "task.complete", ok: false, result: "401" }])).toBe(true);
  });
  test("an applied write → backed", () => {
    expect(unbackedClaim(claim, [{ name: "task.complete", ok: true, result: { applied: true } }])).toBe(false);
  });
  test("no claim → never flagged", () => {
    expect(unbackedClaim("You have 7 open tasks.", [])).toBe(false);
  });
});
