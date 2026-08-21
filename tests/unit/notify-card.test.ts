import { describe, expect, test } from "bun:test";
import { composeCard, CALLBACK_PREFIX, type CardEmail } from "../../convex/notify";

const base: CardEmail = {
  emailMessageId: "msg42",
  accountLabel: "recruiting",
  fromAddress: "s.chen@vercel.com",
  fromName: "Sarah Chen",
  subject: "Interview availability — Senior Frontend Engineer",
  isSpam: true,
  importance: "CRITICAL",
  whyItMatters:
    "Recruiter following up on your application; asks for availability this week. You have not replied.",
  deadlineMentioned: "2026-08-21T09:00:00.000Z",
};

describe("composeCard", () => {
  test("renders the CRITICAL + SPAM badge card from the source mock", () => {
    const card = composeCard(base, "Africa/Lagos");
    expect(card.text).toContain("🔴 CRITICAL");
    expect(card.text).toContain("recruiting");
    expect(card.text).toContain("⚠️ found in SPAM");
    expect(card.text).toContain("Sarah Chen");
    expect(card.text).toContain("Why it matters:");
    expect(card.text).toContain("Deadline mentioned:");
  });

  test("omits the SPAM badge when the message is not in spam", () => {
    const card = composeCard({ ...base, isSpam: false }, "Africa/Lagos");
    expect(card.text).not.toContain("SPAM");
  });

  test("escapes MarkdownV2 special characters in the subject and sender", () => {
    const card = composeCard(
      { ...base, subject: "Re: [URGENT] *now*!", fromName: "A. Chen (Talent)" },
      "Africa/Lagos",
    );
    expect(card.text).toContain("\\[URGENT\\]");
    expect(card.text).toContain("\\*now\\*\\!");
    expect(card.text).toContain("\\(Talent\\)");
  });

  test("formats the deadline in the given timezone using the shared formatter", () => {
    const card = composeCard(base, "Africa/Lagos");
    // 2026-08-21T09:00:00.000Z is 10:00 in Africa/Lagos (UTC+1).
    expect(card.text).toContain("10:00");
  });

  test("omits the why-it-matters and deadline sections when absent", () => {
    const card = composeCard(
      { ...base, whyItMatters: undefined, deadlineMentioned: undefined },
      "Africa/Lagos",
    );
    expect(card.text).not.toContain("Why it matters:");
    expect(card.text).not.toContain("Deadline mentioned:");
  });

  test("wires all four buttons to the right emailMessageId, using CALLBACK_PREFIX", () => {
    const card = composeCard(base, "Africa/Lagos");
    const data = card.buttons.flat().map((b) => b.data);
    expect(data).toEqual([
      `${CALLBACK_PREFIX.TLDR}:msg42`,
      `${CALLBACK_PREFIX.FULL}:msg42`,
      `${CALLBACK_PREFIX.DRAFT}:msg42`,
      `${CALLBACK_PREFIX.NOT_IMPORTANT}:msg42`,
    ]);
  });
});

describe("composeCard — every special character is escaped", () => {
  test("the angle brackets around a sender address are escaped", () => {
    // Regression: escaping fromName and fromAddress separately left the
    // literal <> unescaped, and Telegram rejected the whole card with
    // "Character '>' is reserved and must be escaped".
    const card = composeCard(
      {
        emailMessageId: "m1",
        accountLabel: "personal",
        fromAddress: "no-reply@accounts.google.com",
        fromName: "Google",
        subject: "Security alert",
        isSpam: false,
        importance: "CRITICAL",
      },
      "Africa/Lagos",
    );
    // Only `>` is a MarkdownV2 special; `<` is not, so it stays literal.
    // (The address's own hyphens and dots are escaped too.)
    expect(card.text).toContain("<no");
    expect(card.text).toContain("\\>");
  });

  test("no MarkdownV2 special survives unescaped anywhere in the card", () => {
    const card = composeCard(
      {
        emailMessageId: "m1",
        accountLabel: "client-work",
        fromAddress: "a.b+c@x-y.com",
        fromName: "A [Very] (Tricky) Name!",
        subject: "Re: budget #2 = 50% + more_stuff",
        isSpam: true,
        importance: "CRITICAL",
        whyItMatters: "They need it by Friday - no later.",
      },
      "Africa/Lagos",
    );
    // Walk the rendered text: every special char must be backslash-preceded.
    const SPECIAL = "_*[]()~`>#+-=|{}.!";
    for (let i = 0; i < card.text.length; i++) {
      const ch = card.text[i]!;
      if (!SPECIAL.includes(ch)) continue;
      expect(card.text[i - 1]).toBe("\\");
    }
  });
});
