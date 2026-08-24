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

  test("leaves markdown-ish punctuation in a subject exactly as the sender wrote it", () => {
    const card = composeCard(
      { ...base, subject: "Re: [URGENT] *now*!", fromName: "A. Chen (Talent)" },
      "Africa/Lagos",
    );
    // None of these can break an HTML parse, so none is escaped — and the
    // user reads the real subject rather than a backslash-riddled version.
    expect(card.text).toContain("Re: [URGENT] *now*!");
    expect(card.text).toContain("A. Chen (Talent)");
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
    // Both angle brackets around the address are escaped — in HTML mode "<"
    // is the character that would break the parse, and escaping the name and
    // the address separately (leaving the brackets bare) is what 400'd live.
    expect(card.text).toContain("&lt;no-reply@accounts.google.com&gt;");
    expect(card.text).not.toContain("<no");
  });

  test("no raw angle bracket from sender-controlled data survives", () => {
    const card = composeCard(
      {
        emailMessageId: "m1",
        accountLabel: "client-work",
        fromAddress: "a.b+c@x-y.com",
        fromName: "A [Very] (Tricky) <b>Name</b>!",
        subject: "Re: budget #2 = 50% + more_stuff <script>",
        isSpam: true,
        importance: "CRITICAL",
        whyItMatters: "They need it by Friday - no later. 5 > 3 & rising",
      },
      "Africa/Lagos",
    );

    // The card's OWN tags are the only markup. Strip them, and nothing
    // resembling a tag may remain — that residue would be sender-controlled.
    const withoutOwnTags = card.text.replaceAll(/<\/?b>/g, "");
    expect(withoutOwnTags).not.toContain("<");
    expect(withoutOwnTags).not.toContain(">");

    // MarkdownV2's specials are inert in HTML mode and must NOT be mangled —
    // the subject should read exactly as the sender wrote it.
    expect(card.text).toContain("Re: budget #2 = 50% + more_stuff");
    expect(card.text).not.toContain("\\");
  });
});

describe("a card always names its mailbox", () => {
  // With three inboxes connected, "who is this even for?" is the first
  // question a card has to answer. Before Phase 7 the label was present by
  // accident of composeCard's layout; this makes it a guarantee.
  test.each(["personal", "recruiting", "client"])("names %s", (label) => {
    const card = composeCard({ ...base, accountLabel: label }, "Africa/Lagos");
    expect(card.text).toContain(label);
  });

  test("names the mailbox even when everything optional is absent", () => {
    const card = composeCard(
      {
        emailMessageId: "m1",
        accountLabel: "recruiting",
        fromAddress: "a@b.com",
        isSpam: false,
        importance: "HIGH",
      },
      "Africa/Lagos",
    );
    expect(card.text).toContain("recruiting");
  });

  test("a label containing markup is escaped, not dropped", () => {
    const card = composeCard({ ...base, accountLabel: "client<b>" }, "Africa/Lagos");
    expect(card.text).toContain("client&lt;b&gt;");
  });
});
