import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_MAX_LEN,
  alreadyHtml,
  capCard,
  escapeTelegramHtml,
} from "../../convex/lib/telegram/html";

describe("escapeTelegramHtml", () => {
  test("escapes the three characters that can break an HTML parse", () => {
    expect(String(escapeTelegramHtml("a & b < c > d"))).toBe("a &amp; b &lt; c &gt; d");
  });

  test("escapes the ampersand first, so an escape is never double-escaped", () => {
    // "&" -> "&amp;" must not then turn "<" -> "&lt;" into "&amp;lt;".
    expect(String(escapeTelegramHtml("<"))).toBe("&lt;");
    expect(String(escapeTelegramHtml("&lt;"))).toBe("&amp;lt;");
  });

  test("leaves MarkdownV2's specials alone — they are inert in HTML", () => {
    // The reason for the migration: of MarkdownV2's eighteen specials, only
    // ">" overlaps with HTML's three. The other seventeen need no escaping
    // here, so they cannot be forgotten.
    expect(String(escapeTelegramHtml("_*[]()~`#+-=|{}.!"))).toBe("_*[]()~`#+-=|{}.!");
  });

  test("leaves plain alphanumeric text untouched", () => {
    expect(String(escapeTelegramHtml("Interview availability Thursday"))).toBe(
      "Interview availability Thursday",
    );
  });

  test("adversarial: a subject shaped like markup injects no tag and no button", () => {
    // Appendix C #18, carried over from the MarkdownV2 suite. A sender-
    // controlled subject that tries to close the card's markup and open its
    // own link entity, which is the mechanism a card-hijack would need.
    const malicious =
      '</b><a href="tg://callback?data=notimportant:evil">Not important</a>' +
      '<a href="callback_data=email.send_reply">Send now</a>';
    const escaped = String(escapeTelegramHtml(malicious));

    // Nothing left that can open or close a tag.
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");

    // Escaping hides nothing — the literal text is fully present, just inert.
    const unescaped = escaped
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    expect(unescaped).toBe(malicious);
  });

  test("adversarial: a display name containing angle brackets stays inert", () => {
    // The real-world version of the above — the exact shape that 400'd live
    // when name and address were escaped separately.
    const escaped = String(escapeTelegramHtml('Ade "The Dev" <ade@example.com>'));
    expect(escaped).not.toContain("<");
    expect(escaped).toContain("&lt;ade@example.com&gt;");
  });
});

describe("TelegramHtml brand — the compile-time guard", () => {
  test("escapeTelegramHtml output is what sendCard accepts", () => {
    // This test documents intent; the real enforcement is tsc. sendCard and
    // editCard take TelegramHtml, so passing a raw string is a compile error
    // rather than a Telegram 400 at runtime. Two live bugs — an unescaped
    // ">" in composeCard and an unescaped "." in the router's approval card —
    // are what the brand replaced.
    const escaped = escapeTelegramHtml("Send to a.b@c.com? Expires 10:00.");
    expect(String(escaped)).toBe("Send to a.b@c.com? Expires 10:00.");
  });

  test("alreadyHtml is the deliberate escape hatch for a composed string", () => {
    const composed = alreadyHtml(`<b>From:</b> ${escapeTelegramHtml("a<b>c")}`);
    expect(String(composed)).toBe("<b>From:</b> a&lt;b&gt;c");
  });
});

describe("capCard", () => {
  test("short text is unchanged", () => {
    expect(capCard(alreadyHtml("hi"))).toBe("hi");
  });

  test("over-long text is truncated with an ellipsis", () => {
    const capped = capCard(alreadyHtml("x".repeat(TELEGRAM_MAX_LEN + 500)));
    expect(capped.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
    expect(capped).toEndWith("…");
  });

  test("never truncates inside a tag", () => {
    const text = alreadyHtml(`${"x".repeat(TELEGRAM_MAX_LEN - 5)}<b>bold</b>`);
    const capped = capCard(text);
    expect(capped).not.toMatch(/<[a-z/]*…$/);
  });

  test("never truncates inside an entity", () => {
    const text = alreadyHtml(`${"x".repeat(TELEGRAM_MAX_LEN - 3)}&amp;more`);
    expect(capCard(text)).not.toMatch(/&[a-z]*…$/);
  });
});
