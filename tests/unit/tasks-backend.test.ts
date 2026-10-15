import { describe, expect, test } from "bun:test";
import {
  pickBackend,
  stateTypeForStatus,
  statusForStateType,
  resolveStateForStatus,
  resolveStateByName,
  matchLabels,
  linearPriorityForInternal,
  linearDueDate,
  withBlockerNote,
  withoutBlockerNote,
  hasBlockerNote,
  mentionsTasks,
  normalizeName,
  type TaskStatus,
} from "../../convex/lib/tasks/backend";

describe("pickBackend — a fact, not a judgement", () => {
  test("Linear owns tasks when a Linear account is connected", () => {
    expect(pickBackend(true)).toBe("linear");
  });

  test("the local table owns them when it is not", () => {
    expect(pickBackend(false)).toBe("convex");
  });
});

describe("status <-> Linear state category", () => {
  test("every status maps to a category", () => {
    const statuses: TaskStatus[] = [
      "PLANNED",
      "IN_PROGRESS",
      "BLOCKED",
      "WAITING",
      "RESUMED",
      "COMPLETED",
      "CANCELLED",
    ];
    for (const s of statuses) {
      expect(typeof stateTypeForStatus(s)).toBe("string");
    }
  });

  test("done means completed and cancelled means canceled", () => {
    expect(stateTypeForStatus("COMPLETED")).toBe("completed");
    expect(stateTypeForStatus("CANCELLED")).toBe("canceled");
  });

  test("working on it, resumed and blocked all live in 'started'", () => {
    expect(stateTypeForStatus("IN_PROGRESS")).toBe("started");
    expect(stateTypeForStatus("RESUMED")).toBe("started");
    // Linear has no blocked category; the reason goes in the description.
    expect(stateTypeForStatus("BLOCKED")).toBe("started");
  });

  test("coming back, a category yields a usable status", () => {
    expect(statusForStateType("completed")).toBe("COMPLETED");
    expect(statusForStateType("canceled")).toBe("CANCELLED");
    expect(statusForStateType("started")).toBe("IN_PROGRESS");
    expect(statusForStateType("unstarted")).toBe("WAITING");
    expect(statusForStateType("backlog")).toBe("PLANNED");
    expect(statusForStateType("triage")).toBe("PLANNED");
  });

  test("an unknown category degrades to PLANNED rather than throwing", () => {
    // Linear could add a category; a brief that crashes is worse than one
    // that files an issue under the wrong heading.
    expect(statusForStateType("something_new")).toBe("PLANNED");
    expect(statusForStateType("")).toBe("PLANNED");
  });
});

describe("resolveStateForStatus — the team's own column names never matter", () => {
  // The whole point: this board calls its finished column "Shipped".
  const states = [
    { id: "s1", name: "Triage", type: "triage" },
    { id: "s2", name: "Icebox", type: "backlog" },
    { id: "s3", name: "Building", type: "started" },
    { id: "s4", name: "In Review", type: "started" },
    { id: "s5", name: "Shipped", type: "completed" },
  ];

  test("finds the completed column whatever it is called", () => {
    expect(resolveStateForStatus(states, "COMPLETED")?.name).toBe("Shipped");
  });

  test("finds the started column whatever it is called", () => {
    expect(resolveStateForStatus(states, "IN_PROGRESS")?.name).toBe("Building");
  });

  test("with two states of a category, takes the first — board order", () => {
    expect(resolveStateForStatus(states, "RESUMED")?.id).toBe("s3");
  });

  test("returns null when the team genuinely has no such category", () => {
    // No canceled column on this board.
    expect(resolveStateForStatus(states, "CANCELLED")).toBe(null);
  });

  test("a state the user named wins, and matching ignores case and spacing", () => {
    expect(resolveStateByName(states, "in review")?.id).toBe("s4");
    expect(resolveStateByName(states, "In-Review")?.id).toBe("s4");
    expect(resolveStateByName(states, "  IN REVIEW  ")?.id).toBe("s4");
  });

  test("a name that matches nothing is null, not a wrong column", () => {
    expect(resolveStateByName(states, "Done")).toBe(null);
  });
});

describe("matchLabels — existing labels are reused, not duplicated", () => {
  const existing = [
    { id: "l1", name: "pa" },
    { id: "l2", name: "Back End" },
  ];

  test("matches case- and separator-insensitively", () => {
    expect(matchLabels(existing, ["PA"]).ids).toEqual(["l1"]);
    expect(matchLabels(existing, ["back-end"]).ids).toEqual(["l2"]);
  });

  test("reports what does not exist yet instead of silently inventing it", () => {
    const { ids, missing } = matchLabels(existing, ["pa", "invoices"]);
    expect(ids).toEqual(["l1"]);
    expect(missing).toEqual(["invoices"]);
  });

  test("the same label twice is one id, not two", () => {
    expect(matchLabels(existing, ["pa", "PA", " pa "]).ids).toEqual(["l1"]);
  });

  test("the same missing label twice is proposed once", () => {
    expect(matchLabels(existing, ["new", "NEW"]).missing).toEqual(["new"]);
  });

  test("blank entries are dropped rather than creating an empty label", () => {
    const { ids, missing } = matchLabels(existing, ["", "   "]);
    expect(ids).toEqual([]);
    expect(missing).toEqual([]);
  });
});

describe("priority — the two scales run in opposite directions", () => {
  test("critical becomes urgent, not low", () => {
    // Internal 1 = most urgent; Linear 1 = Urgent. Getting this backwards
    // would silently file every emergency as trivia.
    expect(linearPriorityForInternal(1)).toBe(1);
  });

  test("the least urgent internal value becomes 'no priority', not 'urgent'", () => {
    expect(linearPriorityForInternal(5)).toBe(0);
  });

  test("the middle of the scale is preserved", () => {
    expect(linearPriorityForInternal(2)).toBe(2);
    expect(linearPriorityForInternal(3)).toBe(3);
    expect(linearPriorityForInternal(4)).toBe(4);
  });

  test("absent stays absent — never defaulted to a priority nobody chose", () => {
    expect(linearPriorityForInternal(undefined)).toBe(undefined);
    expect(linearPriorityForInternal(99)).toBe(undefined);
  });
});

describe("linearDueDate", () => {
  test("is a bare date, not an instant", () => {
    expect(linearDueDate(Date.UTC(2026, 8, 6, 13, 45))).toBe("2026-09-06");
  });
});

describe("blocker notes live in the description", () => {
  test("a blocker is prepended, keeping the existing text", () => {
    const out = withBlockerNote("The original description.", "waiting on Paul");
    expect(out).toContain("waiting on Paul");
    expect(out).toContain("The original description.");
    expect(out.startsWith("🚧")).toBe(true);
  });

  test("blocking twice replaces the note rather than stacking them", () => {
    const once = withBlockerNote("body", "first reason");
    const twice = withBlockerNote(once, "second reason");
    expect(twice).toContain("second reason");
    expect(twice).not.toContain("first reason");
    expect(twice).toContain("body");
  });

  test("unblocking removes the note and leaves the description", () => {
    const blocked = withBlockerNote("real content", "waiting");
    const cleared = withoutBlockerNote(blocked);
    expect(cleared).toBe("real content");
    expect(hasBlockerNote(cleared)).toBe(false);
  });

  test("unblocking something that was never blocked is a no-op", () => {
    expect(withoutBlockerNote("just a description")).toBe("just a description");
  });

  test("an absent description is handled, not crashed on", () => {
    expect(withoutBlockerNote(undefined)).toBe("");
    expect(withoutBlockerNote(null)).toBe("");
    expect(withBlockerNote(undefined, "reason")).toContain("reason");
  });
});

describe("mentionsTasks — the gate on paying for a Linear round trip", () => {
  test("ordinary task talk opens the gate", () => {
    for (const message of [
      "what am I working on",
      "add a task to fix the login bug",
      "mark ENG-12 done",
      "I'm blocked on the contract",
      "what's on my board",
      "move that ticket to in progress",
    ]) {
      expect(mentionsTasks(message)).toBe(true);
    }
  });

  test("a turn with nothing task-shaped pays nothing", () => {
    for (const message of ["hi", "thanks!", "what did Paul email me about"]) {
      expect(mentionsTasks(message)).toBe(false);
    }
  });
});

describe("normalizeName", () => {
  test("collapses case, spacing and separators", () => {
    expect(normalizeName("In_Progress")).toBe("in progress");
    expect(normalizeName("  In   Progress ")).toBe("in progress");
    expect(normalizeName("in-progress")).toBe("in progress");
  });
});
