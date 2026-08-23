import { describe, expect, test } from "bun:test";
import {
  describeRule,
  matchRules,
  normalizePattern,
  type EmailRule,
} from "../../convex/lib/email/rules";

const rule = (over: Partial<EmailRule>): EmailRule => ({
  action: "IGNORE",
  ...over,
});

const msg = {
  fromAddress: "no-reply@accounts.google.com",
  subject: "Security alert for your linked Google Account",
  labelIds: ["INBOX", "CATEGORY_UPDATES"],
};

describe("normalizePattern", () => {
  test("lowercases and trims", () => {
    expect(normalizePattern("  NO-Reply@Google.COM ")).toBe("no-reply@google.com");
  });

  test("a bare domain is stored with its leading @", () => {
    // "ignore google.com" and "ignore @google.com" must mean the same thing.
    expect(normalizePattern("google.com")).toBe("@google.com");
    expect(normalizePattern("@google.com")).toBe("@google.com");
  });

  test("a full address keeps its local part", () => {
    expect(normalizePattern("a@b.com")).toBe("a@b.com");
  });
});

describe("matchRules — sender patterns", () => {
  test("an exact address matches", () => {
    const rules = [rule({ senderPattern: "no-reply@accounts.google.com" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
  });

  test("a domain pattern matches any address at that domain", () => {
    // The button path could only ever write an exact address, so "stop
    // showing me anything from Google" was unexpressible before.
    const rules = [rule({ senderPattern: "@accounts.google.com" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
  });

  test("a domain pattern also matches a subdomain", () => {
    const rules = [rule({ senderPattern: "@google.com" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
  });

  test("a domain pattern does NOT match a lookalike domain", () => {
    // "notgoogle.com" must not be caught by "@google.com".
    const rules = [rule({ senderPattern: "@google.com" })];
    expect(matchRules({ ...msg, fromAddress: "x@notgoogle.com" }, rules)).toBeNull();
  });

  test("matching is case-insensitive on both sides", () => {
    const rules = [rule({ senderPattern: "@GOOGLE.com" })];
    expect(matchRules({ ...msg, fromAddress: "X@Google.COM" }, rules)?.action).toBe("IGNORE");
  });

  test("a non-matching sender returns null", () => {
    const rules = [rule({ senderPattern: "@github.com" })];
    expect(matchRules(msg, rules)).toBeNull();
  });
});

describe("matchRules — subject patterns", () => {
  test("a subject fragment matches case-insensitively", () => {
    const rules = [rule({ subjectPattern: "security alert" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
  });

  test("a subject fragment that is absent does not match", () => {
    expect(matchRules(msg, [rule({ subjectPattern: "invoice" })])).toBeNull();
  });

  test("a missing subject never matches a subject rule", () => {
    const rules = [rule({ subjectPattern: "alert" })];
    expect(matchRules({ ...msg, subject: undefined }, rules)).toBeNull();
  });
});

describe("matchRules — combining conditions", () => {
  test("sender AND subject must BOTH match when both are given", () => {
    // "ignore security alerts FROM GOOGLE" must not silence security alerts
    // from the user's bank.
    const rules = [rule({ senderPattern: "@google.com", subjectPattern: "security alert" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
    expect(matchRules({ ...msg, fromAddress: "x@bank.com" }, rules)).toBeNull();
    expect(matchRules({ ...msg, subject: "Your statement" }, rules)).toBeNull();
  });

  test("a Gmail category can be part of a rule", () => {
    const rules = [rule({ category: "CATEGORY_UPDATES", senderPattern: "@google.com" })];
    expect(matchRules(msg, rules)?.action).toBe("IGNORE");
    expect(matchRules({ ...msg, labelIds: ["INBOX"] }, rules)).toBeNull();
  });

  test("a rule with no conditions at all never matches", () => {
    // Guard against an empty rule silencing the entire inbox.
    expect(matchRules(msg, [rule({})])).toBeNull();
  });
});

describe("matchRules — precedence", () => {
  test("FLOOR_HIGH beats IGNORE regardless of order", () => {
    // Never let a broad ignore rule silence something the user separately
    // marked as always-important. Safety direction: err toward showing.
    const rules = [
      rule({ senderPattern: "@google.com", action: "IGNORE" }),
      rule({ subjectPattern: "security alert", action: "FLOOR_HIGH" }),
    ];
    expect(matchRules(msg, rules)?.action).toBe("FLOOR_HIGH");
    expect(matchRules(msg, [...rules].reverse())?.action).toBe("FLOOR_HIGH");
  });

  test("NEVER_ALERT beats IGNORE, since it is the weaker suppression", () => {
    const rules = [
      rule({ senderPattern: "@google.com", action: "IGNORE" }),
      rule({ senderPattern: "@google.com", action: "NEVER_ALERT" }),
    ];
    expect(matchRules(msg, rules)?.action).toBe("NEVER_ALERT");
  });

  test("no rules means no match", () => {
    expect(matchRules(msg, [])).toBeNull();
  });
});

describe("describeRule", () => {
  test("reads back as the sentence the user would have said", () => {
    expect(describeRule(rule({ senderPattern: "@google.com" }))).toContain("from @google.com");
    expect(describeRule(rule({ subjectPattern: "security alert" }))).toContain(
      '"security alert"',
    );
  });

  test("names the action in plain words, not the enum", () => {
    expect(describeRule(rule({ senderPattern: "@x.com", action: "NEVER_ALERT" }))).not.toContain(
      "NEVER_ALERT",
    );
  });
});
