import { describe, expect, test } from "bun:test";
import {
  filterBriefEmails,
  renderBriefFacts,
  sinceYesterdayMidnight,
  type BriefEmail,
  type BriefFactsInput,
} from "../../convex/briefs";

const NOW = Date.parse("2026-08-22T09:00:00Z"); // a Saturday morning, WAT

const email = (over: Partial<BriefEmail> = {}): BriefEmail => ({
  from: "Sarah Chen <sarah@vercel.com>",
  subject: "Interview availability",
  importance: "HIGH",
  labelIds: ["INBOX"],
  inSpam: false,
  receivedAt: NOW - 60 * 60 * 1000, // an hour ago — inside the window by default
  alreadyAlerted: false,
  ...over,
});

const WINDOW = () => {
  const untilMs = NOW;
  const sinceMs = sinceYesterdayMidnight(untilMs, "Africa/Lagos");
  return { sinceMs, untilMs };
};

describe("sinceYesterdayMidnight", () => {
  test("a Saturday brief covers from Friday 00:00 WAT", () => {
    const sinceMs = sinceYesterdayMidnight(NOW, "Africa/Lagos");
    // NOW is Sat 22 Aug 09:00 UTC = Sat 10:00 WAT, so "yesterday" is Friday
    // the 21st. Africa/Lagos is UTC+1, so Friday 00:00 WAT is THURSDAY the
    // 20th at 23:00 UTC. (The original assertion named Friday 23:00 UTC,
    // which is Saturday midnight WAT — today's, not yesterday's.)
    expect(sinceMs).toBe(Date.parse("2026-08-20T23:00:00Z"));
  });
});

describe("filterBriefEmails", () => {
  test("keeps CRITICAL and HIGH inside the window", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL" }), email({ importance: "HIGH" })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(2);
  });

  test("drops NORMAL, LOW, and anything Phase 4 hasn't classified yet", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [
        email({ importance: "NORMAL" }),
        email({ importance: "LOW" }),
        email({ importance: undefined }),
      ],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops promotions and social even when marked HIGH", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [
        email({ importance: "HIGH", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
        email({ importance: "HIGH", labelIds: ["INBOX", "CATEGORY_SOCIAL"] }),
      ],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops anything from BEFORE yesterday midnight — the rolling window, not just 'recent'", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL", receivedAt: sinceMs - 60 * 60 * 1000 })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });

  test("drops an email already pushed as a real-time alert", () => {
    const { sinceMs, untilMs } = WINDOW();
    const out = filterBriefEmails(
      [email({ importance: "CRITICAL", alreadyAlerted: true })],
      sinceMs,
      untilMs,
    );
    expect(out).toHaveLength(0);
  });
});

const baseFacts: BriefFactsInput = {
  timezone: "Africa/Lagos",
  sinceMs: sinceYesterdayMidnight(NOW, "Africa/Lagos"),
  tasks: [],
  blockers: [],
  reminders: [],
  projects: [],
  emails: [],
};

describe("renderBriefFacts", () => {
  test("marks every empty section (none) rather than omitting the label", () => {
    const out = renderBriefFacts(baseFacts);
    expect(out).toContain("OPEN TASKS\n  (none)");
    expect(out).toContain("BLOCKED\n  (none)");
    expect(out).toContain("IMPORTANT EMAIL");
  });

  test("formats a due task and a blocker with resolved local times", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      tasks: [
        {
          title: "Test the FedEx integration",
          status: "PLANNED",
          dueAt: Date.parse("2026-08-21T09:00:00Z"),
        },
      ],
      blockers: [
        {
          taskTitle: "Momentum Logistics server testing",
          description: "waiting on Paul's OTP",
          expectedAt: Date.parse("2026-08-21T09:00:00Z"),
        },
      ],
    });
    expect(out).toContain("Test the FedEx integration — PLANNED, due");
    expect(out).toContain(
      "Momentum Logistics server testing ← waiting on Paul's OTP, expected",
    );
  });

  test("excludes COMPLETED and CANCELLED tasks from OPEN TASKS", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      tasks: [
        { title: "Done thing", status: "COMPLETED" },
        { title: "Dead thing", status: "CANCELLED" },
        { title: "Live thing", status: "PLANNED" },
      ],
    });
    expect(out).not.toContain("Done thing");
    expect(out).not.toContain("Dead thing");
    expect(out).toContain("Live thing");
  });

  test("falls back to a judgement note when no owner notes are set", () => {
    expect(renderBriefFacts(baseFacts)).toContain("(none — use judgement)");
  });

  test("includes owner notes verbatim when given", () => {
    const out = renderBriefFacts({ ...baseFacts, notes: "Skip anything from recruiters." });
    expect(out).toContain("Skip anything from recruiters.");
  });

  test("flags a SPAM-folder email in the important-email section", () => {
    const out = renderBriefFacts({
      ...baseFacts,
      emails: [
        {
          from: "Sarah Chen <sarah@vercel.com>",
          subject: "Interview availability",
          importance: "CRITICAL",
          labelIds: ["SPAM"],
          inSpam: true,
          receivedAt: NOW,
          alreadyAlerted: false,
        },
      ],
    });
    expect(out).toContain("[CRITICAL] Sarah Chen <sarah@vercel.com>");
    expect(out).toContain("found in SPAM");
  });

  test("states the actual window in the section header", () => {
    const out = renderBriefFacts(baseFacts);
    expect(out).toContain("IMPORTANT EMAIL SINCE");
  });
});
