import { describe, expect, test } from "bun:test";
import { renderOutcomes, type ToolOutcome } from "../../convex/lib/tools/outcomes";

const ok = (name: string, result: unknown): ToolOutcome => ({ name, ok: true, result });
const fail = (name: string, error: string): ToolOutcome => ({
  name,
  ok: false,
  result: { error },
});

describe("renderOutcomes", () => {
  test("keeps the planned reply when everything succeeded", () => {
    const out = renderOutcomes("On it.", [ok("task.create", { title: "Test server" })]);
    expect(out).toBe("On it.\n✅ Task created: Test server");
  });

  test("DROPS the planned reply when a tool failed", () => {
    // The plan is written before the tools run, so on failure it typically
    // claims success. Reporting both would be a lie with a warning attached.
    const out = renderOutcomes("Done, task created!", [
      fail("task.create", "No such project"),
    ]);
    expect(out).not.toContain("Done, task created!");
    expect(out).toBe("⚠️ task.create failed: No such project");
  });

  test("renders a reminder with its resolved local time", () => {
    const out = renderOutcomes("", [
      ok("reminder.create", { scheduledFor: "Fri 21 Aug 2026, 10:00" }),
    ]);
    expect(out).toBe("⏰ Reminder set for Fri 21 Aug 2026, 10:00.");
  });

  test("renders a task list as lines, not prose", () => {
    const out = renderOutcomes("", [
      ok("task.list", [
        { title: "Test server", status: "BLOCKED" },
        { title: "Call Paul", status: "PLANNED", dueAt: "Fri 21 Aug 2026, 10:00" },
      ]),
    ]);
    expect(out).toBe(
      "• Test server — BLOCKED\n• Call Paul — PLANNED, due Fri 21 Aug 2026, 10:00",
    );
  });

  test("says so plainly when a list is empty", () => {
    expect(renderOutcomes("", [ok("task.list", [])])).toBe("No tasks match.");
    expect(renderOutcomes("", [ok("reminder.list", [])])).toBe("Nothing scheduled.");
  });

  test("distinguishes created from updated", () => {
    expect(renderOutcomes("", [ok("memory.upsert_project", { created: true })])).toBe(
      "📁 Project created.",
    );
    expect(renderOutcomes("", [ok("memory.upsert_project", { created: false })])).toBe(
      "📁 Project updated.",
    );
  });

  test("a cancel that had nothing to cancel does not claim success", () => {
    expect(
      renderOutcomes("", [ok("reminder.cancel", { cancelled: false, reason: "SENT" })]),
    ).toBe("Nothing to cancel — that reminder is SENT.");
  });

  test("renders several outcomes in order", () => {
    const out = renderOutcomes("Sorted.", [
      ok("task.block", {}),
      ok("reminder.create", { scheduledFor: "Fri 21 Aug 2026, 10:00" }),
    ]);
    expect(out.split("\n")).toEqual([
      "Sorted.",
      "🚧 Marked blocked.",
      "⏰ Reminder set for Fri 21 Aug 2026, 10:00.",
    ]);
  });

  test("an unknown tool still renders something rather than nothing", () => {
    expect(renderOutcomes("", [ok("future.tool", {})])).toBe("✅ future.tool");
  });
});

describe("renderOutcomes — rejected calls", () => {
  test("a rejection invalidates the planned reply", () => {
    // The exact reported bug: the model planned four actions, two were
    // rejected on a type error, and the user was told all four happened.
    const out = renderOutcomes(
      "I've set up the project, created the task and scheduled your reminder.",
      [ok("reminder.create", { scheduledFor: "Thu 20 Aug 2026, 14:00" })],
      [
        { name: "memory.upsert_project", reason: "priority: expected number" },
        { name: "task.create", reason: "priority: expected number" },
      ],
    );
    expect(out).not.toContain("I've set up the project");
    expect(out).toContain("⏰ Reminder set for Thu 20 Aug 2026, 14:00.");
    expect(out).toContain("⚠️ Couldn't do memory.upsert_project");
    expect(out).toContain("⚠️ Couldn't do task.create");
  });

  test("the planned reply survives when nothing was rejected or failed", () => {
    const out = renderOutcomes("On it.", [ok("task.create", { title: "X" })], []);
    expect(out).toBe("On it.\n✅ Task created: X");
  });

  test("never returns an empty message", () => {
    const out = renderOutcomes("", [], [{ name: "task.create", reason: "bad" }]);
    expect(out).toContain("⚠️ Couldn't do task.create");
  });
});

describe("renderOutcomes — connect and email tools", () => {
  test("renders a connect link", () => {
    const out = renderOutcomes("", [
      ok("account.connect_link", { label: "personal", url: "https://x.convex.site/oauth/google/start?state=abc" }),
    ]);
    expect(out).toContain('Connect a mailbox as "personal"');
    expect(out).toContain("https://x.convex.site/oauth/google/start?state=abc");
  });

  test("tells the user to ask, when nothing is connected", () => {
    const out = renderOutcomes("", [ok("email.list_recent", { connected: false })]);
    expect(out).toContain("No mailbox connected");
  });

  test("renders a recent-email list numbered, with sender, subject and spam flag", () => {
    const out = renderOutcomes("", [
      ok("email.list_recent", {
        connected: true,
        withinDays: 2,
        messages: [
          { from: "jobs@corp.example", subject: "Interview", snippet: "Can you...", spam: false },
          { from: "spam@x.example", subject: "You won!!", snippet: "Click now", spam: true },
        ],
      }),
    ]);
    expect(out).toContain("**1. jobs@corp.example**");
    expect(out).toContain("Interview");
    expect(out).toContain("**2. spam@x.example** ⚠️ SPAM");
  });

  test("separates entries with a blank line, so a list is not one paragraph", () => {
    const out = renderOutcomes("", [
      ok("email.list_recent", {
        connected: true,
        withinDays: 2,
        messages: [
          { from: "a@x.example", subject: "One", snippet: "first" },
          { from: "b@x.example", subject: "Two", snippet: "second" },
        ],
      }),
    ]);
    expect(out).toContain("first\n\n");
    expect(out.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  test("a list row names the mailbox it came from", () => {
    const out = renderOutcomes("", [
      ok("email.search", {
        connected: true,
        withinDays: 2,
        query: "x",
        searchedMailboxes: ["primary"],
        messages: [{ from: "a@x.example", subject: "S", accountLabel: "primary" }],
      }),
    ]);
    expect(out).toContain("primary");
  });

  test("says so when a search finds nothing, and offers the next window", () => {
    const out = renderOutcomes("", [
      ok("email.search", { connected: true, query: "x", withinDays: 2, messages: [] }),
    ]);
    expect(out).toContain('matching "x"');
    expect(out).toContain("the last 2 days");
    expect(out).toContain("back to 7 days");
  });

  test("an unknown mailbox label is not reported as 'no mailbox connected'", () => {
    const out = renderOutcomes("", [
      ok("email.search", {
        connected: true,
        unknownLabel: "work",
        available: ["primary", "secondary"],
      }),
    ]);
    expect(out).toContain('no mailbox labelled "work"');
    expect(out).toContain("primary, secondary");
    expect(out).not.toContain("No mailbox connected");
  });

  test("renders a single message with its body, capped only above the real Telegram-sized limit", () => {
    const out = renderOutcomes("", [
      ok("email.get_message", {
        found: true,
        from: "a@b.com",
        subject: "Hi",
        spam: false,
        body: "x".repeat(1000),
      }),
    ]);
    expect(out).toContain("a@b.com");
    expect(out).toContain("Hi");
    // 1000 chars is well under the 3500 cap — must render in full, not the
    // old 800-char cap that cut real emails off after two sentences.
    expect(out).toContain("x".repeat(1000));
  });

  test("a not-found message says so and suggests how to retry", () => {
    const out = renderOutcomes("", [ok("email.get_message", { found: false })]);
    expect(out).toContain("No email matching");
  });
});

describe("renderOutcomes — labelled email results", () => {
  test("an empty SPAM filter says so specifically, not just 'Nothing found'", () => {
    const out = renderOutcomes("", [
      ok("email.list_recent", { connected: true, gmailLabel: "SPAM", withinDays: 2, messages: [] }),
    ]);
    expect(out).toContain("labelled SPAM");
    expect(out).toContain("the last 2 days");
  });

  test("an empty keyword search names the keyword", () => {
    const out = renderOutcomes("", [
      ok("email.search", { connected: true, query: "invoice", withinDays: 2, messages: [] }),
    ]);
    expect(out).toContain('matching "invoice"');
  });

  test("an empty sender search names the sender, not a keyword", () => {
    const out = renderOutcomes("", [
      ok("email.search", { connected: true, from: "paul@x.com", withinDays: 14, messages: [] }),
    ]);
    expect(out).toContain("from paul@x.com");
    expect(out).toContain("last 14 days");
  });
});

describe("renderOutcomes — instructions", () => {
  test("renders a saved instruction", () => {
    const out = renderOutcomes("", [ok("instruction.add", { text: "Never book before 9am" })]);
    expect(out).toContain('I\'ll remember: "Never book before 9am"');
  });
  test("lists saved instructions as bullets", () => {
    const out = renderOutcomes("", [
      ok("instruction.list", [{ text: "Rule one" }, { text: "Rule two" }]),
    ]);
    expect(out).toBe("• Rule one\n• Rule two");
  });
  test("says so when nothing is removed", () => {
    const out = renderOutcomes("", [ok("instruction.remove", { removed: false })]);
    expect(out).toContain("Couldn't find");
  });
});

describe("renderOutcomes — search window is always stated", () => {
  test("a live search names the actual dates it covered", () => {
    const jan1 = Date.UTC(2026, 0, 1);
    const jan15 = Date.UTC(2026, 0, 15);
    const out = renderOutcomes(
      "",
      [
        ok("email.search", {
          connected: true,
          gmailLabel: "SPAM",
          withinDays: 14,
          afterDays: 0,
          searchedFrom: jan1,
          searchedTo: jan15,
          messages: [],
        }),
      ],
      [],
      "UTC",
    );
    expect(out).toContain("Jan");
    expect(out).toContain("last 14 days");
  });

  test("a resumed search says which stretch it covered, not 'the last N days'", () => {
    const out = renderOutcomes(
      "",
      [
        ok("email.search", {
          connected: true,
          query: "x",
          withinDays: 30,
          afterDays: 14,
          searchedFrom: Date.UTC(2026, 0, 1),
          searchedTo: Date.UTC(2026, 0, 17),
          messages: [],
        }),
      ],
      [],
      "UTC",
    );
    expect(out).toContain("14–30 days ago");
  });

  test("the top of the ladder stops offering to go further", () => {
    const out = renderOutcomes("", [
      ok("email.search", { connected: true, query: "x", withinDays: 365, messages: [] }),
    ]);
    expect(out).toContain("as far back as I search");
    expect(out).not.toContain("Want me to keep looking");
  });
});

describe("renderOutcomes — full email body is not over-truncated", () => {
  test("a body under the cap renders whole", () => {
    const body = "x".repeat(500);
    const out = renderOutcomes("", [
      ok("email.get_message", { found: true, from: "a@b.com", subject: "S", spam: false, body }),
    ]);
    expect(out).toContain(body);
    expect(out).not.toContain("truncated");
  });
  test("only a body over 3500 chars gets truncated, with a count", () => {
    const body = "x".repeat(4000);
    const out = renderOutcomes("", [
      ok("email.get_message", { found: true, from: "a@b.com", subject: "S", spam: false, body }),
    ]);
    expect(out).toContain("truncated, 500 more characters");
  });
});

describe("renderOutcomes — skills", () => {
  test("distinguishes created from updated", () => {
    expect(
      renderOutcomes("", [ok("skill.update", { name: "check_email", created: true })]),
    ).toBe('🧩 Skill "check_email" saved.');
    expect(
      renderOutcomes("", [ok("skill.update", { name: "check_email", created: false })]),
    ).toBe('🧩 Skill "check_email" updated.');
  });
  test("lists skills flagging which are customized", () => {
    const out = renderOutcomes("", [
      ok("skill.list", [
        { name: "check_email", customized: true },
        { name: "morning_brief", customized: false },
      ]),
    ]);
    expect(out).toBe("• check_email (customized)\n• morning_brief (default)");
  });
  test("shows a skill's full content", () => {
    const out = renderOutcomes("", [
      ok("skill.get", { found: true, name: "check_email", title: "Check email", content: "Step 1" }),
    ]);
    expect(out).toContain("Check email");
    expect(out).toContain("Step 1");
  });
});

describe("renderOutcomes — user context", () => {
  test("confirms WHAT was noted, not just that something was", () => {
    const out = renderOutcomes("", [
      ok("context.set", { created: true, text: "Frontend engineer, React" }),
    ]);
    expect(out).toBe("🧠 Noted: Frontend engineer, React");
  });

  test("a repeated fact says so instead of claiming a new one", () => {
    expect(renderOutcomes("", [ok("context.set", { created: false, text: "x" })])).toBe(
      "🧠 Already knew that.",
    );
  });

  test("lists facts with their category", () => {
    const out = renderOutcomes("", [
      ok("context.list", [{ category: "profile", text: "Frontend engineer" }]),
    ]);
    expect(out).toBe("• [profile] Frontend engineer");
  });

  test("says so plainly when nothing is known", () => {
    expect(renderOutcomes("", [ok("context.list", [])])).toBe(
      "I don't know anything about you yet.",
    );
  });

  test("a failed removal does not claim success", () => {
    expect(renderOutcomes("", [ok("context.remove", { removed: false })])).toContain(
      "Couldn't find",
    );
  });
});

describe("awaiting approval is not a failure", () => {
  // executeToolCall marks a consequential call ok:false precisely because it
  // did NOT execute. renderOne used to return early on ok:false and print
  // "unknown error", so a correctly-working gate looked broken.
  test("email.send_reply awaiting a tap points at the card", () => {
    const out = renderOutcomes("", [
      {
        name: "email.send_reply",
        ok: false,
        result: { awaitingApproval: true, expiresAt: "Mon, 24 Aug 2026 at 09:00" },
      },
    ]);
    expect(out).toContain("Tap Send");
    expect(out).not.toContain("unknown error");
    expect(out).not.toContain("failed");
  });

  test("linear.apply_changeset awaiting a tap points at the card", () => {
    const out = renderOutcomes("", [
      { name: "linear.apply_changeset", ok: false, result: { awaitingApproval: true } },
    ]);
    expect(out).toContain("Tap Apply");
    expect(out).not.toContain("unknown error");
  });

  test("a genuine failure still reads as one", () => {
    const out = renderOutcomes("", [
      { name: "email.send_reply", ok: false, result: { error: "that draft no longer exists" } },
    ]);
    expect(out).toContain("that draft no longer exists");
  });

  test("a failure with no error field still says something", () => {
    const out = renderOutcomes("", [{ name: "task.create", ok: false, result: {} }]);
    expect(out).toContain("task.create");
  });
});
