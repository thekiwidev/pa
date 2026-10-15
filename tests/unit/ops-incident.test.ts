import { describe, expect, test } from "bun:test";
import {
  REALERT_MS,
  classify,
  fingerprint,
  formatAlert,
  formatDigest,
  scrubSecrets,
  shouldAlert,
} from "../../convex/lib/ops/incident";

describe("scrubSecrets", () => {
  test("removes keys and tokens", () => {
    const text = scrubSecrets(
      "401 for sk-proj-abcdefgh12345678 and lin_api_ABCDEFGH1234 and Bearer ya29.abcdefghijk and https://x?key=AIzaSyAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(text).not.toContain("sk-proj");
    expect(text).not.toContain("lin_api_ABC");
    expect(text).not.toContain("ya29.abc");
    expect(text).toContain("key=[redacted]");
  });
});

describe("fingerprint", () => {
  test("ids and numbers do not split one incident in two", () => {
    expect(fingerprint("gmail.sync:personal", "Gmail 500 on message 18f3a9c2d1e0b7a6"))
      .toBe(fingerprint("gmail.sync:personal", "Gmail 503 on message 19b2c0ffee112233"));
  });
  test("different sources are different incidents", () => {
    expect(fingerprint("gmail.sync:personal", "boom")).not.toBe(fingerprint("gmail.sync:recruiting", "boom"));
  });
  test("short enough for a button", () => {
    expect(fingerprint("a", "b")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("shouldAlert", () => {
  const now = 1_000_000_000;
  test("first critical alerts", () => expect(shouldAlert(null, "critical", now)).toBe(true));
  test("warn never pages", () => expect(shouldAlert(null, "warn", now)).toBe(false));
  test("once an hour", () => {
    expect(shouldAlert({ lastAlertAt: now - 10_000 }, "critical", now)).toBe(false);
    expect(shouldAlert({ lastAlertAt: now - REALERT_MS - 1 }, "critical", now)).toBe(true);
  });
  test("mute wins", () => expect(shouldAlert({ mutedUntil: now + 1 }, "critical", now)).toBe(false));
});

describe("classify", () => {
  test("invalid_grant names the mailbox to reconnect", () => {
    expect(classify("gmail.sync:recruiting", "invalid_grant: Token has been expired")).toEqual({
      severity: "critical",
      fix: "/reconnect recruiting",
    });
  });
  test("a lone 503 is a warning", () => {
    expect(classify("gmail.sync:personal", "Gmail returned 503").severity).toBe("warn");
  });
  test("a broken chat reply is always critical", () => {
    expect(classify("assistant.message", "TypeError: x is undefined").severity).toBe("critical");
  });
});

describe("formatAlert / formatDigest", () => {
  test("says where, what, fix and how often", () => {
    const text = formatAlert({
      source: "gmail.sync:recruiting",
      message: "invalid_grant",
      count: 3,
      firstAt: 0,
      firstAtText: "09:10",
      fix: "/reconnect recruiting",
    });
    expect(text).toBe("🔴 Mail sync (recruiting) failed: invalid_grant\nFix: /reconnect recruiting\n3× since 09:10.");
  });
  test("digest only lists repeats", () => {
    expect(formatDigest([{ source: "gmail.sync:a", message: "503", count: 1 }])).toBeNull();
    expect(formatDigest([{ source: "gmail.sync:a", message: "503", count: 4 }])).toContain("(4×)");
  });
});
