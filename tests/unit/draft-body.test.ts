import { describe, expect, test } from "bun:test";
import {
  BODY_OUTPUT_CONTRACT,
  extractDraftBody,
  looksLikeNarration,
} from "../../convex/lib/email/draftBody";

/**
 * The fixture is the real thing. This exact text reached a real inbox on
 * 2026-08-23 as the BODY of a sent email, because the body-writer call was
 * given a chat-presentation skill as its system prompt and its whole
 * completion was persisted as `bodyText`.
 */
const LEAKED = `Here is a draft reply based on your instructions:

***

### Draft reply

**To:** Adedotun Gabriel <ade.propmail@gmail.com>
**Subject:** Re:

Hi Adedotun,

Thanks for the update. I'll take a look at the OB promotions and Japa Reloaded details as soon as possible before you message Paul.

Best,
Adedotun

***

Please review the draft. If everything looks good, let me know and I will proceed with sending it.`;

describe("looksLikeNarration", () => {
  test("rejects the body that actually leaked to a real inbox", () => {
    expect(looksLikeNarration(LEAKED)).not.toBeNull();
  });

  test.each([
    ["a markdown heading", "### Draft reply\n\nHi there,\n\nThanks.\n\nBest"],
    ["an envelope To: line", "**To:** a@b.com\n\nHi there,\n\nThanks."],
    ["a Subject: line", "Subject: Re: hello\n\nHi there,\n\nThanks."],
    ["a horizontal rule", "Hi there,\n\n***\n\nThanks."],
    ["a preamble about drafting", "Here is a draft reply for you:\n\nHi there,"],
    ["a request to review", "Hi there,\n\nThanks.\n\nPlease review the draft and let me know."],
    ["talking about the user in third person", "I have drafted a reply to this email for you."],
  ])("rejects %s", (_label, body) => {
    expect(looksLikeNarration(body)).not.toBeNull();
  });

  test.each([
    ["a plain reply", "Hi Adedotun,\n\nThanks for the update. I'll look at it today.\n\nBest,\nAdedotun"],
    ["a reply with emphasis", "Hi,\n\nThe **deadline** is Friday.\n\nBest"],
    ["a reply quoting a subject naturally", "Hi,\n\nRe your note about the launch, yes.\n\nBest"],
    ["a reply mentioning review in prose", "Hi,\n\nI'll review the contract tonight.\n\nBest"],
    ["a reply containing a dash rule inside prose", "Hi,\n\nIt cost $3 — well spent.\n\nBest"],
  ])("accepts %s", (_label, body) => {
    expect(looksLikeNarration(body)).toBeNull();
  });
});

describe("extractDraftBody", () => {
  test("reads the body out of the contracted JSON object", () => {
    const raw = '{"body": "Hi,\\n\\nThanks.\\n\\nBest"}';
    expect(extractDraftBody(raw)).toEqual({ ok: true, body: "Hi,\n\nThanks.\n\nBest" });
  });

  test("tolerates a ```json fence, which models add unprompted", () => {
    const raw = '```json\n{"body": "Hi,\\n\\nThanks."}\n```';
    expect(extractDraftBody(raw)).toEqual({ ok: true, body: "Hi,\n\nThanks." });
  });

  test("tolerates a bare ``` fence", () => {
    expect(extractDraftBody('```\n{"body": "Hi."}\n```')).toEqual({ ok: true, body: "Hi." });
  });

  test("tolerates prose around the object, taking the object only", () => {
    // Observed with gemini-3.5-flash: it prepends "Here you go:" perhaps one
    // time in twenty even when told to emit JSON and nothing else.
    const raw = 'Here you go:\n{"body": "Hi.\\n\\nBest"}';
    expect(extractDraftBody(raw)).toEqual({ ok: true, body: "Hi.\n\nBest" });
  });

  test("tolerates doubled braces, the same defect tool-plan parsing hit", () => {
    expect(extractDraftBody('{{"body": "Hi."}}')).toEqual({ ok: true, body: "Hi." });
  });

  test("FAILS on a bare prose completion rather than treating it as a body", () => {
    // This is the whole point: the old code did `.text.trim()` here.
    const result = extractDraftBody(LEAKED);
    expect(result.ok).toBe(false);
  });

  test("FAILS when the JSON parses but the body is narration", () => {
    const raw = JSON.stringify({ body: LEAKED });
    const result = extractDraftBody(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("narration");
  });

  test("FAILS on an empty body rather than sending a blank email", () => {
    expect(extractDraftBody('{"body": "   "}').ok).toBe(false);
  });

  test("FAILS on a missing body field", () => {
    expect(extractDraftBody('{"reply": "Hi."}').ok).toBe(false);
  });

  test("a failure carries a reason that can be shown to the user", () => {
    const result = extractDraftBody("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("BODY_OUTPUT_CONTRACT", () => {
  test("names the exact JSON shape so a skill cannot redefine the output", () => {
    expect(BODY_OUTPUT_CONTRACT).toContain('"body"');
  });

  test("forbids the envelope fields that leaked", () => {
    expect(BODY_OUTPUT_CONTRACT.toLowerCase()).toContain("subject");
  });
});
