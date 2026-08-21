import { describe, expect, test } from "bun:test";
import { escapeMarkdownV2 } from "../../convex/lib/telegram/markdown";

describe("escapeMarkdownV2", () => {
  test("escapes every MarkdownV2 special character", () => {
    const input = "_*[]()~`>#+-=|{}.!";
    const escaped = escapeMarkdownV2(input);
    for (const ch of input) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  test("escapes a literal backslash, the escape character itself", () => {
    expect(String(escapeMarkdownV2("C:\\Users\\ade"))).toBe("C:\\\\Users\\\\ade");
  });

  test("leaves plain alphanumeric text untouched", () => {
    expect(String(escapeMarkdownV2("Interview availability Thursday"))).toBe(
      "Interview availability Thursday",
    );
  });

  test("adversarial: a subject with every special char plus a fake button row survives intact and injects no callback", () => {
    // Appendix C #18. Every MarkdownV2 metacharacter, plus a string shaped
    // like a link entity that would fake a button if it survived unescaped.
    const maliciousSubject =
      '_*[]()~`>#+-=|{}.! [Not important](tg://callback?data=notimportant:evil) [Send now](callback_data=email.send_reply)';
    const escaped = escapeMarkdownV2(maliciousSubject);

    // No unescaped "[" or "(" survives -- there is nothing left that could
    // open a MarkdownV2 link/entity, which is the mechanism a card-hijack
    // would need.
    expect(escaped).not.toMatch(/(?<!\\)\[/);
    expect(escaped).not.toMatch(/(?<!\\)\(/);

    // The literal text is still fully present -- escaping hides nothing,
    // it just makes it inert.
    const unescaped = escaped.replace(/\\(.)/g, "$1");
    expect(unescaped).toBe(maliciousSubject);
  });
});

describe("EscapedMarkdown brand — the compile-time guard", () => {
  test("escapeMarkdownV2 output is what sendCard accepts", () => {
    // This test documents intent; the real enforcement is tsc. sendCard and
    // editCard take EscapedMarkdown, so passing a raw string is a compile
    // error rather than a Telegram 400 at runtime. Two live bugs — an
    // unescaped `>` in composeCard and unescaped `.` in the router's
    // approval card — are what this replaced.
    const escaped = escapeMarkdownV2("Send to a.b@c.com? Expires 10:00.");
    expect(String(escaped)).toContain("\\.");
    expect(String(escaped)).toContain("a\\.b@c\\.com");
  });
});
