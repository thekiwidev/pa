import { describe, expect, test } from "bun:test";
import {
  normalizeMessage,
  parseAddress,
  parseAddressList,
  parseAuthResults,
  stripHtml,
  decodeBase64Url,
  BODY_CAP_BYTES,
  cleanSnippet,
} from "../../convex/connectors/gmail/normalize";
import {
  GMAIL_READONLY_SCOPES,
  GMAIL_SEND_SCOPES,
} from "../../convex/connectors/gmail/oauth";

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

describe("parseAddress", () => {
  test("splits a display name from an address", () => {
    expect(parseAddress('"Ada Lovelace" <ada@example.com>')).toEqual({
      address: "ada@example.com",
      name: "Ada Lovelace",
    });
  });
  test("handles a bare address", () => {
    expect(parseAddress("ada@example.com")).toEqual({ address: "ada@example.com" });
  });
  test("lower-cases the address", () => {
    expect(parseAddress("Ada@Example.COM").address).toBe("ada@example.com");
  });
});

describe("parseAddressList", () => {
  test("does not split on a comma inside a quoted display name", () => {
    expect(
      parseAddressList('"Lovelace, Ada" <ada@example.com>, bob@example.com'),
    ).toEqual(["ada@example.com", "bob@example.com"]);
  });
  test("empty for a missing header", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("decodeBase64Url", () => {
  test("round-trips UTF-8, not just ASCII", () => {
    // A latin-1 decode would mojibake this; mail is full of it.
    expect(decodeBase64Url(b64url("Adedotun — café 😀"))).toBe("Adedotun — café 😀");
  });
});

describe("parseAuthResults", () => {
  test("extracts all three verdicts", () => {
    expect(
      parseAuthResults("mx.google.com; spf=pass; dkim=pass; dmarc=fail (p=NONE)"),
    ).toEqual({ spf: "pass", dkim: "pass", dmarc: "fail" });
  });
  test("missing methods report none, not undefined", () => {
    expect(parseAuthResults("mx.google.com; spf=softfail")).toEqual({
      spf: "softfail",
      dkim: "none",
      dmarc: "none",
    });
  });
});

describe("stripHtml", () => {
  test("drops script and style content entirely", () => {
    expect(stripHtml("<style>a{}</style><p>Hi</p><script>x()</script>")).toBe("Hi");
  });
  test("turns block ends into newlines and decodes entities", () => {
    expect(stripHtml("<p>a &amp; b</p><p>c</p>")).toBe("a & b\nc");
  });
});

describe("normalizeMessage", () => {
  const base = {
    id: "m1",
    threadId: "t1",
    labelIds: ["SPAM", "CATEGORY_PROMOTIONS"],
    snippet: "a snippet",
    internalDate: "1755648000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: '"Recruiter" <jobs@corp.example>' },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "hr@corp.example, boss@corp.example" },
        { name: "Subject", value: "Interview invitation" },
        { name: "Message-ID", value: "<abc@corp.example>" },
        { name: "List-Unsubscribe", value: "<https://corp.example/u>" },
        { name: "Authentication-Results", value: "mx; spf=pass; dkim=pass; dmarc=pass" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Can you interview Tuesday?") } },
        {
          mimeType: "application/pdf",
          filename: "jd.pdf",
          body: { size: 4096, attachmentId: "att1" },
        },
      ],
    },
  };

  test("keeps SPAM in labelIds — the whole point of the phase", () => {
    expect(normalizeMessage(base).labelIds).toContain("SPAM");
  });

  test("extracts headers, addresses and body deterministically", () => {
    const n = normalizeMessage(base);
    expect(n.fromAddress).toBe("jobs@corp.example");
    expect(n.fromName).toBe("Recruiter");
    expect(n.ccAddresses).toEqual(["hr@corp.example", "boss@corp.example"]);
    expect(n.subject).toBe("Interview invitation");
    expect(n.bodyText).toBe("Can you interview Tuesday?");
    expect(n.receivedAt).toBe(1755648000000);
    expect(n.authResults).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(n.listUnsubscribe).toBe("<https://corp.example/u>");
  });

  test("records attachments without downloading them", () => {
    const n = normalizeMessage(base);
    expect(n.hasAttachments).toBe(true);
    expect(n.attachments).toEqual([
      { filename: "jd.pdf", mimeType: "application/pdf", sizeBytes: 4096 },
    ]);
    // The attachment must NOT have been treated as body text.
    expect(n.bodyText).not.toContain("jd.pdf");
  });

  test("prefers text/plain over text/html", () => {
    const n = normalizeMessage({
      ...base,
      payload: {
        ...base.payload,
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>HTML version</p>") } },
          { mimeType: "text/plain", body: { data: b64url("Plain version") } },
        ],
      },
    });
    expect(n.bodyText).toBe("Plain version");
  });

  test("falls back to stripped HTML when there is no plain part", () => {
    const n = normalizeMessage({
      ...base,
      payload: {
        ...base.payload,
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>Only HTML</p>") } }],
      },
    });
    expect(n.bodyText).toBe("Only HTML");
  });

  test("caps the body and flags the truncation", () => {
    const n = normalizeMessage({
      ...base,
      payload: {
        ...base.payload,
        parts: [{ mimeType: "text/plain", body: { data: b64url("x".repeat(50_000)) } }],
      },
    });
    expect(n.bodyTruncated).toBe(true);
    expect(n.bodyText!.length).toBeLessThan(BODY_CAP_BYTES + 200);
    expect(n.bodyText).toContain("truncated");
  });

  test("survives a message with no payload at all", () => {
    const n = normalizeMessage({ id: "m2", threadId: "t2" });
    expect(n.fromAddress).toBe("");
    expect(n.bodyText).toBeUndefined();
    expect(n.hasAttachments).toBe(false);
  });
});

describe("scopes — least privilege", () => {
  test("Phase 3 requests gmail.readonly and NOTHING else", () => {
    expect(GMAIL_READONLY_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  test("never requests full mailbox access", () => {
    for (const scope of GMAIL_READONLY_SCOPES) {
      expect(scope).not.toBe("https://mail.google.com/");
      expect(scope).not.toContain("gmail.send");
      expect(scope).not.toContain("gmail.modify");
      expect(scope).not.toContain("gmail.compose");
    }
  });

  test("Phase 6 adds compose + send, and nothing beyond that yet", () => {
    expect(GMAIL_SEND_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    for (const scope of GMAIL_SEND_SCOPES) {
      expect(scope).not.toBe("https://mail.google.com/");
      expect(scope).not.toContain("gmail.modify");
    }
  });
});

describe("cleanSnippet", () => {
  test("decodes HTML entities Gmail leaves raw", () => {
    expect(cleanSnippet("you don&#39;t need to &amp; do anything")).toBe(
      "you don't need to & do anything",
    );
  });
  test("strips zero-width padding characters", () => {
    expect(cleanSnippet("Finish your setup ‌ ‌ ‌")).toBe("Finish your setup");
  });
  test("passes through undefined", () => {
    expect(cleanSnippet(undefined)).toBeUndefined();
  });
});
