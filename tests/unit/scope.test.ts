import { describe, expect, test } from "bun:test";
import { guardReply, wantsFullEmail } from "../../convex/lib/scope";

describe("guardReply", () => {
  test("catches the exact fabricated claim from the incident", () => {
    // The model told the user "I am looking into the OAuth error. I will
    // check the authentication configuration" — it cannot inspect Google
    // Cloud Console and never called a tool that could.
    expect(guardReply("I am looking into the OAuth error. I will check the authentication configuration.")).not.toContain("looking into");
  });

  test("catches a claim of fixing infrastructure", () => {
    expect(guardReply("I am updating the configuration now.")).not.toContain(
      "updating the configuration",
    );
  });

  test("catches a claim of investigating a redirect URI", () => {
    expect(
      guardReply("The OAuth redirect URI is misconfigured. I am fixing it."),
    ).toBe(
      "I can't inspect or change external configuration — Google Cloud Console, " +
        "environment variables, or the code itself. If something is failing, tell " +
        "me the exact error text and I can explain what it usually means; fixing " +
        "it is on your side.",
    );
  });

  test("does NOT flag a benign use of 'check'", () => {
    const reply = "Let me check your tasks — you have three open.";
    expect(guardReply(reply)).toBe(reply);
  });

  test("does NOT flag reporting a past, already-surfaced error", () => {
    const reply = "That reminder failed with: no such task.";
    expect(guardReply(reply)).toBe(reply);
  });

  test("does NOT flag ordinary conversation", () => {
    const reply = "Connected ade.propmail@gmail.com as personal.";
    expect(guardReply(reply)).toBe(reply);
  });
});

describe("guardReply — precision", () => {
  test("a bare 'I am checking' with no infra noun is NOT flagged", () => {
    const reply = "I am checking your tasks now.";
    expect(guardReply(reply)).toBe(reply);
  });

  test("'I'll investigate' with an infra noun several words later is flagged", () => {
    expect(
      guardReply("I'll investigate why the redirect uri keeps failing."),
    ).not.toContain("investigate");
  });
});

describe("wantsFullEmail", () => {
  test("catches the explicit phrasings from the skill's FULL CONTENT MODE", () => {
    for (const phrase of [
      "show me the full email",
      "give me the full email content",
      "what's the full content?",
      "give me the entire email",
      "show me everything in the email",
      "read the full email to me",
      "I want the complete message",
    ]) {
      expect(wantsFullEmail(phrase)).toBe(true);
    }
  });

  test("does NOT fire on summary-mode phrasings", () => {
    for (const phrase of [
      "what does the email say?",
      "what's the email about?",
      "summarize this email",
      "give me the gist",
      "is this email important?",
      "what do they want from me?",
    ]) {
      expect(wantsFullEmail(phrase)).toBe(false);
    }
  });

  test("does not fire on unrelated messages", () => {
    expect(wantsFullEmail("remind me to call Paul at 2pm")).toBe(false);
  });
});
