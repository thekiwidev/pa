// Tests for the 2026-10-15 cleanup (docs/BEHAVIOUR.md): email references,
// availability across calendars, meeting nudges, alert history, task ranking.
import { describe, expect, test } from "bun:test";
import {
  collectEmailRefs,
  renderEmailRef,
  resolveFocus,
  substituteRefs,
} from "../../convex/lib/assistant/refs";
import {
  checkAvailability,
  dedupeEvents,
  nudgeText,
  upcomingForNudge,
  type CalendarItem,
} from "../../convex/lib/calendar/availability";
import { dateWindow, resolveWindow } from "../../convex/lib/calendar/window";
import { cleanLinearKey, looksLikeLinearKey } from "../../convex/lib/linear/apiKey";
import { withJsonReminder } from "../../convex/lib/ai/prompt";
import { formatClock, formatDayTime, formatInstant, formatWhen } from "../../convex/lib/time";
import { backendForAccounts } from "../../convex/lib/tasks/backend";
import { parseToolPlan } from "../../convex/lib/tools/plan";
import { cardAsHistory } from "../../convex/notify";
import { rankBriefTasks } from "../../convex/briefs";

const TZ = "Africa/Lagos"; // UTC+1, no DST
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("email refs", () => {
  const outcomes = [
    {
      name: "email.search",
      ok: true,
      result: {
        messages: [
          { emailMessageId: "id-a", from: "Polaris Bank", subject: "Statement", receivedAtMs: at("2026-10-14T08:00:00Z") },
          { emailMessageId: "id-b", from: "Paul", subject: "Invoice" },
        ],
      },
    },
    { name: "email.get", ok: true, result: { emailMessageId: "id-a", from: "Polaris Bank", subject: "Statement" } },
    { name: "email.search", ok: false, result: { messages: [{ emailMessageId: "id-c" }] } },
  ];

  test("labels emails E1.. in order, dedupes, skips failed tools", () => {
    const refs = collectEmailRefs(outcomes);
    expect(refs.map((r) => [r.ref, r.id])).toEqual([
      ["E1", "id-a"],
      ["E2", "id-b"],
    ]);
  });

  test("renders who / what / when without the database id", () => {
    const [first] = collectEmailRefs(outcomes);
    const line = renderEmailRef(first!, TZ);
    expect(line).toContain("from Polaris Bank");
    expect(line).toContain('subject "Statement"');
    expect(line).not.toContain("id-a");
  });

  test("substituteRefs swaps a label (and 'focus') for the real id", () => {
    const refs = new Map([["E0", "focus-id"], ["E2", "id-b"]]);
    const calls = substituteRefs(
      [
        { name: "email.get_message", args: { emailMessageId: "e2" } },
        { name: "email.get_message", args: { emailMessageId: "focus" } },
        { name: "email.get_message", args: { emailMessageId: "E9" } },
        { name: "email.search", args: { from: "Paul" } },
      ],
      refs,
    );
    expect(calls.map((c) => c.args.emailMessageId)).toEqual(["id-b", "focus-id", "E9", undefined]);
  });

  test("resolveFocus finds the item the model pointed at", () => {
    const refs = collectEmailRefs(outcomes);
    expect(resolveFocus("e2", refs)?.id).toBe("id-b");
    expect(resolveFocus(undefined, refs)).toBeUndefined();
    expect(resolveFocus("E7", refs)).toBeUndefined();
  });

  test("parseToolPlan keeps a valid focus label and drops junk", () => {
    expect(parseToolPlan('{"reply":"x","tools":[],"focus":"e1"}').focus).toBe("E1");
    expect(parseToolPlan('{"reply":"x","tools":[],"focus":"the bank one"}').focus).toBeUndefined();
  });
});

describe("availability", () => {
  const ev = (title: string, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
    title,
    startMs: at(start),
    endMs: at(end),
    calendarOf: "work",
    ...extra,
  });
  const events = [
    ev("Standup", "2026-10-22T09:00:00Z", "2026-10-22T09:30:00Z"),
    ev("Call with Paul", "2026-10-22T15:15:00Z", "2026-10-22T15:45:00Z"),
    ev("Birthday", "2026-10-22T00:00:00Z", "2026-10-23T00:00:00Z", { allDay: true }),
  ];

  test("free, but mentions an event within the hour", () => {
    const a = checkAvailability({ startMs: at("2026-10-22T14:00:00Z"), endMs: at("2026-10-22T15:00:00Z"), events });
    expect(a.free).toBe(true);
    expect(a.nearby.map((e) => e.title)).toContain("Call with Paul");
  });

  test("an overlap is a conflict", () => {
    const a = checkAvailability({ startMs: at("2026-10-22T09:15:00Z"), endMs: at("2026-10-22T10:00:00Z"), events });
    expect(a.free).toBe(false);
    expect(a.conflicts.map((e) => e.title)).toEqual(["Standup"]);
  });

  test("an all-day event never makes a slot busy", () => {
    const a = checkAvailability({ startMs: at("2026-10-22T12:00:00Z"), endMs: at("2026-10-22T12:30:00Z"), events });
    expect(a.free).toBe(true);
    expect(a.nearby.map((e) => e.title)).toEqual(["Birthday"]);
  });

  test("dedupeEvents merges the same event seen on two calendars", () => {
    const twice = [events[0]!, { ...events[0]!, calendarOf: "personal" }];
    expect(dedupeEvents(twice)).toHaveLength(1);
  });

  test("upcomingForNudge picks events starting within the lead time only", () => {
    const now = at("2026-10-22T08:35:00Z");
    expect(upcomingForNudge(events, now, 30 * MIN).map((e) => e.title)).toEqual(["Standup"]);
    expect(upcomingForNudge(events, at("2026-10-22T09:05:00Z"), 30 * MIN)).toEqual([]);
  });

  test("nudgeText gives minutes, local clock and the join link", () => {
    const text = nudgeText(
      { title: "Standup", startMs: at("2026-10-22T09:00:00Z"), link: "https://meet.google.com/x" },
      at("2026-10-22T08:30:00Z"),
      TZ,
    );
    expect(text).toBe("📅 Standup in 30 min (10:00).\nJoin: https://meet.google.com/x");
  });
});

describe("calendar windows", () => {
  test("dateWindow is the local day", () => {
    const w = dateWindow("2026-10-22", TZ);
    expect(w.startMs).toBe(at("2026-10-21T23:00:00Z"));
    expect(w.endMs).toBe(at("2026-10-22T23:00:00Z"));
  });

  test("resolveWindow prefers a date, falls back to today", () => {
    const now = at("2026-10-15T10:00:00Z");
    expect(resolveWindow({ date: "2026-10-22", window: "this_week" }, now, TZ).startMs).toBe(
      at("2026-10-21T23:00:00Z"),
    );
    expect(resolveWindow({}, now, TZ).startMs).toBe(at("2026-10-14T23:00:00Z"));
  });
});

describe("formatWhen", () => {
  const now = at("2026-10-15T10:00:00Z");
  test("today / yesterday / a date", () => {
    expect(formatWhen(at("2026-10-15T08:42:00Z"), now, TZ)).toBe("today 09:42");
    expect(formatWhen(at("2026-10-14T19:00:00Z"), now, TZ)).toBe("yesterday 20:00");
    expect(formatWhen(at("2026-10-10T19:00:00Z"), now, TZ)).not.toContain("today");
  });
});

describe("backendForAccounts", () => {
  test("any Linear account means Linear, even when inactive", () => {
    expect(backendForAccounts([{ provider: "linear", status: "REVOKED" }])).toBe("linear");
    expect(backendForAccounts([{ provider: "google", status: "ACTIVE" }])).toBe("convex");
    expect(backendForAccounts([])).toBe("convex");
  });
});

describe("cardAsHistory", () => {
  test("puts the alert into the conversation with sender, mailbox and time", () => {
    const line = cardAsHistory(
      {
        emailMessageId: "x",
        accountLabel: "work",
        fromAddress: "hr@acme.com",
        fromName: "Acme HR",
        subject: "Offer letter",
        isSpam: false,
        importance: "HIGH",
        whyItMatters: "Your offer letter is ready to sign.",
        receivedAt: at("2026-10-15T08:42:00Z"),
      },
      TZ,
      at("2026-10-15T10:00:00Z"),
    );
    expect(line).toContain("Acme HR");
    expect(line).toContain("work, today 09:42");
    expect(line).toContain('subject "Offer letter"');
  });
});

describe("rankBriefTasks", () => {
  test("overdue, then due today, then in progress, then the rest, blocked last", () => {
    const now = at("2026-10-15T08:00:00Z");
    const endOfToday = at("2026-10-15T23:00:00Z");
    const ranked = rankBriefTasks(
      [
        { title: "blocked", status: "BLOCKED" },
        { title: "later", status: "PLANNED" },
        { title: "doing", status: "IN_PROGRESS" },
        { title: "today", status: "PLANNED", dueAt: at("2026-10-15T15:00:00Z") },
        { title: "overdue", status: "PLANNED", dueAt: at("2026-10-14T15:00:00Z") },
      ],
      now,
      endOfToday,
    );
    expect(ranked.map((t) => t.title)).toEqual(["overdue", "today", "doing", "later", "blocked"]);
  });
});

describe("date formatting does not depend on the runtime's ICU version", () => {
  // Bun 1.4 on macOS formats the combined en-GB pattern as "Thu 15 Oct at
  // 09:42"; older ICU writes "Thu 15 Oct, 09:42". Pin the exact strings.
  const t = at("2026-10-15T08:42:00Z");
  test("formatDayTime", () => {
    expect(formatDayTime(t, TZ)).toBe("Thu 15 Oct, 09:42");
  });
  test("formatInstant", () => {
    expect(formatInstant(t, TZ)).toBe("Thu 15 Oct 2026, 09:42");
  });
  test("midnight is 00:00, never 24:00", () => {
    expect(formatClock(at("2026-10-14T23:00:00Z"), TZ)).toBe("00:00");
  });
});

describe("Linear API key hygiene", () => {
  test("strips whitespace and surrounding quotes", () => {
    expect(cleanLinearKey('  "lin_api_abc123"\n')).toBe("lin_api_abc123");
    expect(cleanLinearKey("'lin_api_abc123'")).toBe("lin_api_abc123");
  });
  test("recognises a personal key and rejects other secrets", () => {
    expect(looksLikeLinearKey("lin_api_abc123")).toBe(true);
    expect(looksLikeLinearKey("Bearer lin_api_abc123")).toBe(false);
    expect(looksLikeLinearKey("lin_oauth_abc")).toBe(false);
  });
});

describe("OpenAI JSON mode always has 'json' in the input", () => {
  test("appends the reminder only when JSON output is requested", () => {
    expect(withJsonReminder("User: hi", true).toLowerCase()).toContain("json");
    expect(withJsonReminder("User: hi", false)).toBe("User: hi");
    expect(withJsonReminder("User: hi", undefined)).toBe("User: hi");
  });
});
