import { describe, expect, test } from "bun:test";
import { FOLLOWUP_AFTER_MS, alertStep, isUnread } from "../../convex/lib/email/unread";

describe("isUnread", () => {
  test("only the UNREAD label counts", () => {
    expect(isUnread(["INBOX", "UNREAD"])).toBe(true);
    expect(isUnread(["INBOX"])).toBe(false);
    expect(isUnread([])).toBe(false);
  });
});

describe("alertStep", () => {
  test("a read message stops the chain whatever the policy says", () => {
    expect(alertStep({ read: true, policy: "send" })).toBe("stop");
    expect(alertStep({ read: true, policy: "defer" })).toBe("stop");
  });
  test("unread and allowed alerts", () => {
    expect(alertStep({ read: false, policy: "send" })).toBe("alert");
  });
  test("quiet hours defer instead of losing the alert", () => {
    expect(alertStep({ read: false, policy: "defer" })).toBe("defer");
  });
  test("a dropped kind ends the chain", () => {
    expect(alertStep({ read: false, policy: "drop" })).toBe("stop");
  });
});

test("the reminder waits 48 hours", () => {
  expect(FOLLOWUP_AFTER_MS).toBe(172_800_000);
});
