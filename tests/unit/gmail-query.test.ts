import { describe, expect, test } from "bun:test";
import {
  buildGmailQuery,
  nextRung,
  searchWindow,
  SEARCH_LADDER,
} from "../../convex/lib/email/gmailQuery";

describe("buildGmailQuery — typed fields become operators", () => {
  test("a sender becomes from:, quoted", () => {
    expect(buildGmailQuery({ from: "paul@x.com" })).toBe('from:"paul@x.com"');
  });

  test("a subject becomes subject:, quoted so a phrase stays one term", () => {
    expect(buildGmailQuery({ subject: "contract renewal" })).toBe('subject:"contract renewal"');
  });

  test("free text is quoted, never left bare", () => {
    expect(buildGmailQuery({ query: "invoice" })).toBe('"invoice"');
  });

  test("fields combine, with free text last", () => {
    expect(buildGmailQuery({ from: "paul", query: "invoice", gmailLabel: "SPAM" })).toBe(
      'from:"paul" label:SPAM "invoice"',
    );
  });

  test("nothing in, nothing out — never a stray operator", () => {
    expect(buildGmailQuery({})).toBe("");
  });
});

describe("buildGmailQuery — the model cannot smuggle in syntax", () => {
  // This is the bug the whole module exists to remove. The old code passed
  // the model's `query` string straight into Gmail's `q`, so anything it
  // wrote was executed as search syntax.
  test("a query containing from: searches for those literal words", () => {
    const q = buildGmailQuery({ query: "from:attacker@evil.com" });
    expect(q).toBe('"from:attacker@evil.com"');
    // The operator is INSIDE the quotes — it is a phrase, not a filter.
    expect(q.startsWith('"')).toBe(true);
  });

  test("a quote in a value cannot break out of the phrase", () => {
    // Gmail has no escape for a double quote, so it is stripped rather than
    // escaped — a search that silently loses a character beats one that
    // becomes a different query.
    const q = buildGmailQuery({ from: 'paul" OR label:inbox' });
    expect(q).toBe('from:"paul OR label:inbox"');
    expect(q.split('"').length).toBe(3);
  });

  test("backslashes are stripped, not passed through", () => {
    expect(buildGmailQuery({ query: 'a\\"b' })).toBe('"a b"');
  });

  test("a label that never came from the enum is scrubbed", () => {
    // The colon goes too, so a scrubbed label can never become a second operator.
    expect(buildGmailQuery({ gmailLabel: "SPAM OR is:starred" })).toBe("label:SPAMORisstarred");
  });

  test("a value that is only punctuation contributes no term at all", () => {
    expect(buildGmailQuery({ from: '"""' })).toBe("");
  });
});

describe("buildGmailQuery — date windows", () => {
  test("renders Gmail's YYYY/MM/DD form", () => {
    const q = buildGmailQuery({ query: "x", afterMs: Date.UTC(2026, 0, 5) });
    expect(q).toContain("after:2026/01/05");
  });

  test("before: is pushed a day out, since Gmail excludes the named day", () => {
    const q = buildGmailQuery({ query: "x", beforeMs: Date.UTC(2026, 0, 15) });
    expect(q).toContain("before:2026/01/16");
  });

  test("a full window carries both bounds", () => {
    const q = buildGmailQuery({
      from: "paul",
      afterMs: Date.UTC(2026, 0, 1),
      beforeMs: Date.UTC(2026, 0, 15),
    });
    expect(q).toBe('from:"paul" after:2026/01/01 before:2026/01/16');
  });
});

describe("searchWindow — widening cannot repeat itself", () => {
  const now = Date.UTC(2026, 8, 6);
  const DAY = 24 * 60 * 60 * 1000;

  test("the first pass reaches back N days and ends now", () => {
    const w = searchWindow(now, 14);
    expect(w.beforeMs).toBe(now);
    expect(w.afterMs).toBe(now - 14 * DAY);
  });

  test("the second pass starts where the first stopped", () => {
    const first = searchWindow(now, 14, 0);
    const second = searchWindow(now, 30, 14);
    // No overlap: the older window ends exactly where the newer one began.
    expect(second.beforeMs).toBe(first.afterMs);
    expect(second.afterMs).toBeLessThan(second.beforeMs);
  });

  test("afterDays can never swallow the whole window", () => {
    const w = searchWindow(now, 7, 99);
    expect(w.afterDays).toBe(6);
    expect(w.afterMs).toBeLessThan(w.beforeMs);
  });

  test("a nonsense withinDays still yields a usable window", () => {
    const w = searchWindow(now, 0, 0);
    expect(w.withinDays).toBe(1);
    expect(w.afterMs).toBeLessThan(w.beforeMs);
  });
});

describe("nextRung — the ladder is fixed, not invented per call", () => {
  test("climbs to the next rung above the current depth", () => {
    expect(nextRung(2)).toBe(7);
    expect(nextRung(7)).toBe(14);
    expect(nextRung(14)).toBe(30);
    expect(nextRung(30)).toBe(90);
    expect(nextRung(90)).toBe(365);
  });

  test("a depth between rungs climbs to the next one up", () => {
    expect(nextRung(10)).toBe(14);
  });

  test("the top of the ladder has nowhere to go", () => {
    expect(nextRung(365)).toBe(null);
    expect(nextRung(1000)).toBe(null);
  });

  test("the ladder only ever ascends", () => {
    const rungs = [...SEARCH_LADDER];
    expect([...rungs].sort((a, b) => a - b)).toEqual(rungs);
  });
});
